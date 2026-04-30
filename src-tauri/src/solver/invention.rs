//! Invention node building and probability calculations.

use std::collections::HashMap;

use crate::types::{BuildNode, Decision, InventionBlueprint, NodeKind, TypeId, TypeSummary};

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

    base * (1.0 + 0.01 * enc_skill)
        * (1.0 + 0.1 * (dc_skill_sum / 30.0))
        * decrypter_multiplier
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

// ─── Invention node ───────────────────────────────────────────────────────────

/// Build the `Invention` `BuildNode` for a T2 product.
///
/// `bpcs_needed` is the number of T2 BPCs required to cover the manufacturing
/// runs above. Each BPC covers `inv_bp.output_runs` manufacturing runs.
pub fn solve_invention_node(
    inv_bp: &InventionBlueprint,
    bpcs_needed: u32,
    product_type_summary: &TypeSummary,
    _depth: u32,
    state: &mut SolverState,
) -> BuildNode {
    let probability = calculate_probability(
        inv_bp.base_probability,
        inv_bp,
        &state.input.character_skills,
        1.0, // decrypter multiplier — decrypter support to be added later
    );
    let attempts = attempts_needed(bpcs_needed, probability);

    // ── Datacore inputs ───────────────────────────────────────────────────────
    let mut inputs = Vec::new();
    for &(dc_type_id, qty_per_attempt) in &inv_bp.datacores {
        let total_qty = qty_per_attempt * attempts as u64;
        let dc_summary = state.input.type_summaries.get(&dc_type_id).cloned()
            .unwrap_or_else(|| TypeSummary {
                type_id: dc_type_id,
                type_name: format!("Datacore [{dc_type_id}]"),
                category_id: 0,
                volume: 0.0,
            });
        // Datacores are always bought (never built)
        inputs.push(super::node::buy_node(dc_type_id, &dc_summary, total_qty, state));
    }

    // ── T1 BPC input (one copy per attempt) ──────────────────────────────────
    // If the player owns the T1 BPO in their assets, copying is free (one BPO
    // makes unlimited copies). Only show as a buy cost if they don't own it.
    let t1_summary = state.input.type_summaries.get(&inv_bp.t1_blueprint_type_id).cloned()
        .unwrap_or_else(|| TypeSummary {
            type_id: inv_bp.t1_blueprint_type_id,
            type_name: format!("T1 BPC [{0}]", inv_bp.t1_blueprint_type_id),
            category_id: 0,
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

    let invention_info = crate::types::InventionInfo {
        base_blueprint_type_id: inv_bp.t1_blueprint_type_id,
        probability,
        runs_per_bpc: inv_bp.output_runs,
        output_me: inv_bp.output_me,
        output_te: inv_bp.output_te,
        datacores: datacore_lines,
        decrypter: None,
    };

    let on_hand = consume_stock(&mut state.available_assets, inv_bp.t1_blueprint_type_id, 0);
    let in_progress = consume_stock(&mut state.available_jobs, inv_bp.t1_blueprint_type_id, 0);

    BuildNode {
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
        job_cost: None, // invention job cost calculated separately if needed
        inputs,
    }
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
