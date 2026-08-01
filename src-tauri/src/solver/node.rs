// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Recursive build node solver.

use std::collections::HashMap;

use crate::types::{
    ActivityId, BlueprintData, BuildNode, Decision, JobType, NodeKind, TypeId, TypeSummary,
};

use super::{cost, invention, SolverState};

/// Hard recursion depth limit — prevents infinite loops on malformed SDE data.
const MAX_DEPTH: u32 = 64;

// ─── Entry ────────────────────────────────────────────────────────────────────

/// Recursively resolve one type into a `BuildNode`.
///
/// `structure_profile_id` is inherited from the parent (or target) unless
/// overridden via `manual_decisions`.
pub fn solve_node(
    type_id: TypeId,
    quantity_needed: u64,
    depth: u32,
    structure_profile_id: Option<&str>,
    state: &mut SolverState,
) -> BuildNode {
    let summary = state
        .input
        .type_summaries
        .get(&type_id)
        .cloned()
        .unwrap_or_else(|| TypeSummary {
            type_id,
            type_name: format!("Unknown [{type_id}]"),
            category_id: 0,
            group_id: 0,
            volume: 0.0,
        });

    let decision = determine_decision(type_id, depth, state);

    match decision {
        Decision::Buy | Decision::UseHangar => buy_node(type_id, &summary, quantity_needed, state),
        Decision::Build => {
            build_industry_node(type_id, &summary, quantity_needed, depth, structure_profile_id, state)
        }
    }
}

// ─── Decision ─────────────────────────────────────────────────────────────────

fn determine_decision(type_id: TypeId, depth: u32, state: &SolverState) -> Decision {
    if depth >= MAX_DEPTH || state.seen.contains(&type_id) {
        return Decision::Buy;
    }
    if state.input.blacklist.contains(&type_id) {
        return Decision::Buy;
    }
    if let Some(&d) = state.input.manual_decisions.get(&type_id) {
        return d;
    }
    if state.input.blueprints.contains_key(&type_id) {
        Decision::Build
    } else {
        Decision::Buy
    }
}

// ─── Buy node ─────────────────────────────────────────────────────────────────

/// Build a leaf Buy node, deducting available assets and hangar stock.
pub fn buy_node(
    type_id: TypeId,
    summary: &TypeSummary,
    quantity_needed: u64,
    state: &mut SolverState,
) -> BuildNode {
    let on_hand = consume_stock(&mut state.available_assets, type_id, quantity_needed);
    let in_progress = consume_stock(
        &mut state.available_jobs,
        type_id,
        quantity_needed.saturating_sub(on_hand),
    );
    let from_hangar = consume_stock(
        &mut state.available_hangar,
        type_id,
        quantity_needed.saturating_sub(on_hand + in_progress),
    );
    // on_hand is capped to this node's need, so remaining stock stays available
    // for sibling nodes needing the same type elsewhere in the plan.
    let to_buy = quantity_needed.saturating_sub(on_hand + in_progress + from_hangar);

    BuildNode {
        type_id,
        type_name: summary.type_name.clone(),
        kind: NodeKind::Buy,
        decision: Decision::Buy,
        runs: 0,
        quantity_produced: 0,
        quantity_needed,
        quantity_on_hand: on_hand,
        quantity_in_progress: in_progress,
        quantity_from_hangar: from_hangar,
        quantity_to_hangar: 0,
        quantity_to_buy: to_buy,
        unit_volume: summary.volume,
        category_id: summary.category_id,
        group_id: summary.group_id,
        job_cost: None,
        inputs: vec![],
    }
}

// ─── Industry node ────────────────────────────────────────────────────────────

fn build_industry_node(
    type_id: TypeId,
    summary: &TypeSummary,
    quantity_needed: u64,
    depth: u32,
    structure_profile_id: Option<&str>,
    state: &mut SolverState,
) -> BuildNode {
    // Borrow from `state.input` (lifetime `'a`, independent of `&mut state`
    // below) instead of cloning the blueprint on every recursive call.
    let input = state.input;
    let bp = &input.blueprints[&type_id];
    let category_id = summary.category_id;

    // ── Structure profile resolution ──────────────────────────────────────────
    // `structure_profile_id` is inherited unchanged from the target/parent, but
    // a build tree typically spans multiple activities (e.g. a Manufacturing
    // target that reacts its own materials or invents its own BPCs). Resolve
    // the profile that actually matches *this* node's activity rather than
    // blindly trusting the inherited one.
    let node_job_type = match bp.activity {
        ActivityId::Reaction => JobType::Reaction,
        _ => JobType::Manufacturing,
    };
    let resolved_profile_id =
        cost::resolve_profile_id(structure_profile_id, node_job_type, &state.input.structure_profiles);

    // ── ME / rig bonus ────────────────────────────────────────────────────────
    let rig_me = resolved_profile_id
        .and_then(|id| state.input.structure_profiles.get(id))
        .map(|p| cost::get_rig_me(p, category_id))
        .unwrap_or(0.0);

    // ── Stock deduction ───────────────────────────────────────────────────────
    // For top-level targets (depth == 0) the user explicitly wants to BUILD
    // this item, so existing stock is shown as informational but never cancels
    // the build.  For intermediate nodes (depth > 0) stock deduction is normal.
    let (on_hand, in_progress, from_hangar, effective_need) = if depth == 0 {
        let oh = state.available_assets.get(&type_id).copied().unwrap_or(0).min(quantity_needed);
        let ip = state.available_jobs.get(&type_id).copied().unwrap_or(0).min(quantity_needed);
        let fh = state.available_hangar.get(&type_id).copied().unwrap_or(0).min(quantity_needed);
        // Do NOT consume from the maps; effective_need is always the full quantity.
        (oh, ip, fh, quantity_needed)
    } else {
        let oh_consumed = consume_stock(&mut state.available_assets, type_id, quantity_needed);
        let ip = consume_stock(
            &mut state.available_jobs,
            type_id,
            quantity_needed.saturating_sub(oh_consumed),
        );
        let fh = consume_stock(
            &mut state.available_hangar,
            type_id,
            quantity_needed.saturating_sub(oh_consumed + ip),
        );
        let en = quantity_needed.saturating_sub(oh_consumed + ip + fh);
        (oh_consumed, ip, fh, en)
    };

    // ── Batch / run math ──────────────────────────────────────────────────────
    let runs = if effective_need == 0 {
        0
    } else {
        runs_needed(effective_need, bp.output_quantity)
    };
    let quantity_produced = bp.output_quantity * runs as u64;
    let quantity_to_hangar = quantity_produced.saturating_sub(effective_need);

    // Deposit overbuild into hangar for downstream nodes.
    if quantity_to_hangar > 0 {
        *state.available_hangar.entry(type_id).or_insert(0) += quantity_to_hangar;
    }

    // ── Invention resolution (T2/T3 items) ────────────────────────────────────
    // Must happen before material recursion: an invented BPC's ME/TE is fixed
    // at invention time (base + decrypter modifier) and is NOT the user's
    // global blueprint research level, which only applies to owned BPOs.
    let mut invention_node = None;
    let (me_level, te_level) = if let Some(inv_bp) = &bp.invention {
        let stock_me_te = state
            .input
            .bpc_inventory
            .get(&type_id)
            .map(|e| (e.me_level, e.te_level));
        let stock_covered =
            consume_stock(&mut state.available_bpc_runs, type_id, runs as u64) as u32;
        let remaining_runs = runs - stock_covered;

        if remaining_runs == 0 {
            stock_me_te.unwrap_or((10, 20))
        } else {
            let decrypter_choice = state.input.decrypter_choices.get(&type_id).copied();
            // `resolved_profile_id` (Manufacturing) is what downstream mfg-time
            // math inside invention needs — the invented product's own job runs
            // on the Manufacturing structure, not the Invention one.
            let (node, eff_me, eff_te) = invention::solve_invention_node(
                inv_bp,
                remaining_runs,
                summary,
                decrypter_choice,
                &bp.materials,
                rig_me,
                resolved_profile_id,
                depth + 1,
                state,
                stock_covered as u64,
            );
            invention_node = Some(node);
            (eff_me, eff_te)
        }
    } else {
        // Clamp to the game's valid ME/TE ranges — an out-of-range value here
        // (e.g. from a corrupted saved plan) would otherwise flow into
        // `apply_me`'s `bp_factor` and silently floor to a wrong-but-plausible
        // 1-material-per-run result instead of erroring.
        (
            state.input.me_levels.get(&type_id).copied().unwrap_or(10).clamp(0, 10),
            state.input.te_levels.get(&type_id).copied().unwrap_or(20).clamp(0, 20),
        )
    };

    // ── Recurse into materials ────────────────────────────────────────────────
    state.seen.insert(type_id);
    let inputs = build_inputs(bp, runs, me_level, rig_me, depth, structure_profile_id, state);
    state.seen.remove(&type_id);

    let mut all_inputs = inputs;
    if let Some(node) = invention_node {
        all_inputs.push(node);
    }

    // ── Build node kind ───────────────────────────────────────────────────────
    let kind = match bp.activity {
        ActivityId::Manufacturing => NodeKind::Manufacturing {
            me: me_level,
            te: te_level,
            max_runs: if bp.max_production_limit == 0 {
                None
            } else {
                Some(bp.max_production_limit)
            },
            structure_profile_id: resolved_profile_id.map(str::to_string),
        },
        ActivityId::Reaction => NodeKind::Reaction {
            te: te_level,
            structure_profile_id: resolved_profile_id.map(str::to_string),
        },
        _ => NodeKind::Buy, // fallback; shouldn't occur for well-formed SDE data
    };

    // ── Job cost ──────────────────────────────────────────────────────────────
    let system_id = resolved_profile_id
        .and_then(|id| state.input.structure_profiles.get(id))
        .and_then(|p| p.solar_system_id);

    // EIV uses total material quantities after ME.
    let mat_totals: Vec<(TypeId, u64)> = all_inputs
        .iter()
        .filter(|n| !matches!(n.kind, NodeKind::Invention(_)))
        .map(|n| (n.type_id, n.quantity_needed))
        .collect();
    let eiv_value = cost::eiv(&mat_totals, &state.input.adjusted_prices);
    let job_cost = cost::job_cost(eiv_value, bp.activity, system_id, resolved_profile_id, state.input);

    BuildNode {
        type_id,
        type_name: summary.type_name.clone(),
        kind,
        decision: Decision::Build,
        runs,
        quantity_produced,
        quantity_needed,
        quantity_on_hand: on_hand,
        quantity_in_progress: in_progress,
        quantity_from_hangar: from_hangar,
        quantity_to_hangar,
        quantity_to_buy: 0,
        unit_volume: summary.volume,
        category_id: summary.category_id,
        group_id: summary.group_id,
        job_cost,
        inputs: all_inputs,
    }
}

/// Recurse into each material line, applying ME and batch math.
fn build_inputs(
    bp: &BlueprintData,
    runs: u32,
    me_level: u8,
    rig_me: f64,
    depth: u32,
    structure_profile_id: Option<&str>,
    state: &mut SolverState,
) -> Vec<BuildNode> {
    bp.materials
        .iter()
        .map(|&(mat_id, qty_per_run)| {
            let total_qty = cost::apply_me(qty_per_run, runs, me_level, rig_me);
            solve_node(mat_id, total_qty, depth + 1, structure_profile_id, state)
        })
        .collect()
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// `ceil(quantity / output_per_run)` — how many runs to satisfy a quantity need.
pub(super) fn runs_needed(quantity: u64, output_per_run: u64) -> u32 {
    if output_per_run == 0 {
        return 0;
    }
    (quantity.saturating_add(output_per_run - 1) / output_per_run).min(u32::MAX as u64) as u32
}

/// Consume up to `limit` units from a mutable stock map.
/// Returns how many were actually consumed.
pub fn consume_stock(stock: &mut HashMap<TypeId, u64>, type_id: TypeId, limit: u64) -> u64 {
    if limit == 0 {
        return 0;
    }
    let available = stock.entry(type_id).or_insert(0);
    let consumed = (*available).min(limit);
    *available -= consumed;
    consumed
}