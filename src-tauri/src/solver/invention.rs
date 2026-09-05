// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Invention node building, decrypter selection, and probability calculations.

use std::collections::HashMap;

use crate::types::{BuildNode, Decision, DecrypterInfo, InventionBlueprint, NodeKind, TypeId, TypeSummary};

use super::cost::apply_me;
use super::decrypters::{find_decrypter, DecrypterSpec, DECRYPTERS};
use super::node::runs_needed;
use super::schedule::effective_mfg_time;
use super::SolverState;

// ─── Probability ──────────────────────────────────────────────────────────────

/// Calculate the final invention success probability.
///
/// Formula (from AGENTS.md):
/// `P = base × (1 + 0.01 × enc_skill) × (1 + 0.1 × Σ(dc_skill / 30)) × decrypter_mult`
///
/// `relevant_skill_ids` layout: `[encryption_skill_id, dc_skill_1_id, dc_skill_2_id]`
pub fn calculate_probability(
    base: f64,
    inv_bp: &InventionBlueprint,
    skills: &HashMap<TypeId, u8>,
    decrypter_multiplier: f64,
) -> f64 {
    let enc_skill = inv_bp
        .relevant_skill_ids
        .first()
        .and_then(|id| skills.get(id))
        .copied()
        .unwrap_or(0) as f64;

    let dc_skill_sum: f64 = inv_bp
        .relevant_skill_ids
        .iter()
        .skip(1)
        .map(|id| skills.get(id).copied().unwrap_or(0) as f64)
        .sum();

    // EVE caps invention success chance at 100% regardless of skill/decrypter stacking.
    (base * (1.0 + 0.01 * enc_skill)
        * (1.0 + 0.1 * (dc_skill_sum / 30.0))
        * decrypter_multiplier)
        .min(1.0)
}

/// Number of invention attempts needed to produce `bpcs_needed` BPCs,
/// given `probability` per attempt.
///
/// `attempts = ceil(bpcs_needed / probability)`
pub fn attempts_needed(bpcs_needed: u32, probability: f64) -> u32 {
    if probability <= 0.0 {
        return u32::MAX; // guard against zero probability
    }
    (bpcs_needed as f64 / probability).ceil() as u32
}

// ─── Decrypter candidate evaluation ────────────────────────────────────────────

/// One evaluated decrypter option (or "none"), used by the auto-pick loop.
#[derive(Clone, Copy)]
struct Candidate {
    effective_runs: u32,
    effective_me: u8,
    effective_te: u8,
    probability: f64,
    bpcs_needed: u32,
    attempts: u32,
    total_cost: f64,
    total_time_seconds: u64,
}

#[allow(clippy::too_many_arguments)]
fn evaluate_candidate(
    spec: Option<&'static DecrypterSpec>,
    inv_bp: &InventionBlueprint,
    manufacturing_runs: u32,
    skills: &HashMap<TypeId, u8>,
    adjusted_prices: &HashMap<TypeId, f64>,
    product_materials: &[(TypeId, u64)],
    rig_me: f64,
    product_type_id: TypeId,
    structure_profile_id: Option<&str>,
    input: &crate::types::SolverInput,
) -> Candidate {
    let run_mod = spec.map(|s| s.run_modifier).unwrap_or(0);
    let me_mod = spec.map(|s| s.me_modifier).unwrap_or(0);
    let te_mod = spec.map(|s| s.te_modifier).unwrap_or(0);
    let prob_mult = spec.map(|s| s.probability_multiplier).unwrap_or(1.0);

    let effective_runs = (inv_bp.output_runs as i32 + run_mod).max(1) as u32;
    let effective_me = (inv_bp.output_me as i32 + me_mod).clamp(0, 10) as u8;
    let effective_te = (inv_bp.output_te as i32 + te_mod).clamp(0, 20) as u8;

    let probability = calculate_probability(inv_bp.base_probability, inv_bp, skills, prob_mult);
    let bpcs_needed = runs_needed(manufacturing_runs as u64, effective_runs as u64);
    let attempts = attempts_needed(bpcs_needed, probability);

    let datacore_cost: f64 = inv_bp
        .datacores
        .iter()
        .map(|&(dc_type_id, qty_per_attempt)| {
            let price = adjusted_prices.get(&dc_type_id).copied().unwrap_or(0.0);
            qty_per_attempt as f64 * attempts as f64 * price
        })
        .sum();
    let decrypter_cost = spec
        .map(|s| adjusted_prices.get(&s.type_id).copied().unwrap_or(0.0) * attempts as f64)
        .unwrap_or(0.0);

    // A decrypter's ME modifier changes the effective ME of the invented BPC,
    // which directly scales material consumption for every manufacturing run
    // built from it (see `cost::apply_me`). A cheap-but-low-ME decrypter can
    // cost far more overall than its invention-phase price suggests, so that
    // downstream material cost has to be part of the comparison, not just the
    // datacore/decrypter spend.
    let material_cost: f64 = product_materials
        .iter()
        .map(|&(mat_type_id, qty_per_run)| {
            let qty = apply_me(qty_per_run, manufacturing_runs, effective_me, rig_me);
            qty as f64 * adjusted_prices.get(&mat_type_id).copied().unwrap_or(0.0)
        })
        .sum();

    // A decrypter's TE modifier changes the effective TE of the invented BPC,
    // which scales every downstream manufacturing run's job duration. Invention
    // itself has a fixed attempt duration (decrypters don't affect it), so total
    // time = invention time (attempts × per-attempt time) + manufacturing time
    // (runs × effective per-run time at this candidate's TE).
    let mfg_time = effective_mfg_time(product_type_id, effective_te, structure_profile_id, input);
    let total_time_seconds =
        attempts as u64 * inv_bp.time_seconds as u64 + manufacturing_runs as u64 * mfg_time as u64;

    Candidate {
        effective_runs,
        effective_me,
        effective_te,
        probability,
        bpcs_needed,
        attempts,
        total_cost: datacore_cost + decrypter_cost + material_cost,
        total_time_seconds,
    }
}

// ─── Invention node ───────────────────────────────────────────────────────────

/// Build the `Invention` `BuildNode` for a T2 product.
///
/// `manufacturing_runs` is the number of manufacturing runs of the T2 product
/// that must be covered; each invented BPC covers a decrypter-dependent number
/// of runs, so the BPC count is computed inside this function once the
/// applicable decrypter is resolved.
///
/// Returns `(node, effective_me, effective_te)` — the effective ME/TE are fed
/// back to the caller so the T2 manufacturing node (and its material
/// recursion) use the invented BPC's actual research levels instead of the
/// user's global ME/TE defaults, which don't apply to invented copies.
#[allow(clippy::too_many_arguments)]
pub fn solve_invention_node(
    inv_bp: &InventionBlueprint,
    manufacturing_runs: u32,
    product_type_summary: &TypeSummary,
    decrypter_choice: Option<TypeId>,
    product_materials: &[(TypeId, u64)],
    rig_me: f64,
    structure_profile_id: Option<&str>,
    _depth: u32,
    state: &mut SolverState,
    runs_from_stock: u64,
) -> (BuildNode, u8, u8) {
    let skills = &state.input.character_skills;
    let adjusted_prices = &state.input.adjusted_prices;
    let optimize_for_time = state.input.optimize_decrypters_for_time;
    let product_type_id = product_type_summary.type_id;

    let eval = |spec: Option<&'static DecrypterSpec>| {
        evaluate_candidate(
            spec, inv_bp, manufacturing_runs, skills, adjusted_prices, product_materials, rig_me,
            product_type_id, structure_profile_id, state.input,
        )
    };

    let none_candidate = eval(None);

    let mut best = None;
    let mut best_candidate = none_candidate;
    let mut best_score = if optimize_for_time {
        none_candidate.total_time_seconds as f64
    } else {
        none_candidate.total_cost
    };
    for spec in DECRYPTERS {
        let c = eval(Some(spec));
        let score = if optimize_for_time { c.total_time_seconds as f64 } else { c.total_cost };
        if score < best_score {
            best_score = score;
            best = Some(spec);
            best_candidate = c;
        }
    }
    let best_decrypter_type_id = best.map(|s| s.type_id);

    let is_overridden = decrypter_choice.is_some();
    // Explicit override wins outright; otherwise reuse the winning candidate
    // the auto-pick loop above already computed instead of re-evaluating it.
    let applied_spec = match decrypter_choice {
        Some(choice) => find_decrypter(choice),
        None => best,
    };
    let applied = match decrypter_choice {
        Some(_) => eval(applied_spec),
        None => best_candidate,
    };
    let isk_saved_vs_no_decrypter = none_candidate.total_cost - applied.total_cost;

    let bpcs_needed = applied.bpcs_needed;
    let attempts = applied.attempts;
    let probability = applied.probability;

    // ── Datacore inputs ───────────────────────────────────────────────────────
    let mut inputs = Vec::new();
    for &(dc_type_id, qty_per_attempt) in &inv_bp.datacores {
        let total_qty = qty_per_attempt * attempts as u64;
        let dc_summary = state.input.type_summaries.get(&dc_type_id).cloned()
            .unwrap_or_else(|| TypeSummary {
                type_id: dc_type_id,
                type_name: format!("Datacore [{dc_type_id}]"),
                category_id: 0,
                group_id: 0,
                volume: 0.0,
            });
        // Datacores are always bought (never built)
        inputs.push(super::node::buy_node(dc_type_id, &dc_summary, total_qty, state));
    }

    // ── Decrypter input (one copy per attempt, consumed regardless of success) ─
    if let Some(spec) = applied_spec {
        let decrypter_summary = state.input.type_summaries.get(&spec.type_id).cloned()
            .unwrap_or_else(|| TypeSummary {
                type_id: spec.type_id,
                type_name: spec.name.to_string(),
                category_id: 0,
                group_id: 0,
                volume: 0.0,
            });
        inputs.push(super::node::buy_node(spec.type_id, &decrypter_summary, attempts as u64, state));
    }

    // ── T1 BPC input (one copy per attempt) ──────────────────────────────────
    // If the player owns the T1 BPO in their assets, copying is free (one BPO
    // makes unlimited copies). Only show as a buy cost if they don't own it.
    let t1_summary = state.input.type_summaries.get(&inv_bp.t1_blueprint_type_id).cloned()
        .unwrap_or_else(|| TypeSummary {
            type_id: inv_bp.t1_blueprint_type_id,
            type_name: format!("T1 BPC [{0}]", inv_bp.t1_blueprint_type_id),
            category_id: 0,
            group_id: 0,
            volume: 0.0,
        });
    let owns_t1_bpo = state.input.assets.get(&inv_bp.t1_blueprint_type_id).copied().unwrap_or(0) > 0;
    let t1_qty_needed = if owns_t1_bpo { 0 } else { attempts as u64 };
    inputs.push(super::node::buy_node(
        inv_bp.t1_blueprint_type_id,
        &t1_summary,
        t1_qty_needed,
        state,
    ));

    // Build MaterialLines from inv_bp.datacores directly — don't reconstruct
    // from the already-resolved BuildNode inputs.
    let datacore_lines: Vec<crate::types::MaterialLine> = inv_bp
        .datacores
        .iter()
        .map(|&(type_id, qty_per_attempt)| {
            let type_name = state
                .input
                .type_summaries
                .get(&type_id)
                .map(|t| t.type_name.clone())
                .unwrap_or_else(|| format!("Datacore [{type_id}]"));
            let volume = state
                .input
                .type_summaries
                .get(&type_id)
                .map(|t| t.volume)
                .unwrap_or(0.0);
            crate::types::MaterialLine {
                type_id,
                type_name,
                quantity_per_run: qty_per_attempt,
                quantity_total: qty_per_attempt * attempts as u64,
                unit_volume: volume,
            }
        })
        .collect();

    let decrypter_info = applied_spec.map(|spec| DecrypterInfo {
        type_id: spec.type_id,
        type_name: spec.name.to_string(),
        run_modifier: spec.run_modifier,
        me_modifier: spec.me_modifier,
        te_modifier: spec.te_modifier,
        probability_multiplier: spec.probability_multiplier,
    });

    let invention_info = crate::types::InventionInfo {
        base_blueprint_type_id: inv_bp.t1_blueprint_type_id,
        probability,
        runs_per_bpc: applied.effective_runs,
        output_me: applied.effective_me,
        output_te: applied.effective_te,
        datacores: datacore_lines,
        decrypter: decrypter_info,
        time_per_attempt_seconds: inv_bp.time_seconds,
        best_decrypter_type_id,
        is_overridden,
        isk_saved_vs_no_decrypter,
        runs_from_stock,
    };

    let on_hand = consume_stock(&mut state.available_assets, inv_bp.t1_blueprint_type_id, 0);
    let in_progress = consume_stock(&mut state.available_jobs, inv_bp.t1_blueprint_type_id, 0);

    let node = BuildNode {
        type_id: product_type_summary.type_id,
        type_name: format!("{} (Invention)", product_type_summary.type_name),
        kind: NodeKind::Invention(invention_info),
        decision: Decision::Build,
        runs: attempts,
        quantity_produced: bpcs_needed as u64,
        quantity_needed: bpcs_needed as u64,
        quantity_on_hand: on_hand,
        quantity_in_progress: in_progress,
        quantity_from_hangar: 0,
        quantity_to_hangar: 0,
        quantity_to_buy: 0,
        unit_volume: product_type_summary.volume,
        category_id: product_type_summary.category_id,
        group_id: product_type_summary.group_id,
        job_cost: None,
        inputs,
    };

    (node, applied.effective_me, applied.effective_te)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Consume up to `limit` units from a mutable stock map (0 = don't consume, just peek).
fn consume_stock(stock: &mut HashMap<TypeId, u64>, type_id: TypeId, limit: u64) -> u64 {
    if limit == 0 {
        return stock.get(&type_id).copied().unwrap_or(0);
    }
    let available = stock.entry(type_id).or_insert(0);
    let consumed = (*available).min(limit);
    *available -= consumed;
    consumed
}
