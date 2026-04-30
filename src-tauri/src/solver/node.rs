//! Recursive build node solver.

use std::collections::HashMap;

use crate::types::{
    ActivityId, BlueprintData, BuildNode, Decision, NodeKind, TypeId, TypeSummary,
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
    let (on_hand, consumed_assets) = read_and_consume(&mut state.available_assets, type_id, quantity_needed);
    let in_progress = consume_stock(
        &mut state.available_jobs,
        type_id,
        quantity_needed.saturating_sub(consumed_assets),
    );
    let from_hangar = consume_stock(
        &mut state.available_hangar,
        type_id,
        quantity_needed.saturating_sub(consumed_assets + in_progress),
    );
    // on_hand is actual inventory; saturating_sub handles the case where it exceeds need.
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
    let bp = state.input.blueprints[&type_id].clone();
    let category_id = summary.category_id;

    // ── ME / rig bonus ────────────────────────────────────────────────────────
    let me_level = state.input.me_levels.get(&type_id).copied().unwrap_or(10);
    let rig_me = structure_profile_id
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
        let (oh_actual, oh_consumed) = read_and_consume(&mut state.available_assets, type_id, quantity_needed);
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
        // effective_need uses consumed (not actual) so runs are calculated correctly.
        let en = quantity_needed.saturating_sub(oh_consumed + ip + fh);
        (oh_actual, ip, fh, en)
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

    // ── Recurse into materials ────────────────────────────────────────────────
    state.seen.insert(type_id);
    let inputs = build_inputs(&bp, runs, me_level, rig_me, depth, structure_profile_id, state);
    state.seen.remove(&type_id);

    // ── Invention node (T2 items) ─────────────────────────────────────────────
    let mut all_inputs = inputs;
    if let Some(inv_bp) = &bp.invention {
        let inv_bp = inv_bp.clone();
        // How many BPCs we need: each covers inv_bp.output_runs manufacturing runs.
        let bpcs_needed = runs_needed(runs as u64, inv_bp.output_runs as u64);
        let invention_node =
            invention::solve_invention_node(&inv_bp, bpcs_needed, summary, depth + 1, state);
        all_inputs.push(invention_node);
    }

    // ── Build node kind ───────────────────────────────────────────────────────
    let kind = match bp.activity {
        ActivityId::Manufacturing => NodeKind::Manufacturing {
            me: me_level,
            te: state.input.te_levels.get(&type_id).copied().unwrap_or(20),
            max_runs: if bp.max_production_limit == 0 {
                None
            } else {
                Some(bp.max_production_limit)
            },
            structure_profile_id: structure_profile_id.map(str::to_string),
        },
        ActivityId::Reaction => NodeKind::Reaction {
            te: state.input.te_levels.get(&type_id).copied().unwrap_or(20),
            structure_profile_id: structure_profile_id.map(str::to_string),
        },
        _ => NodeKind::Buy, // fallback; shouldn't occur for well-formed SDE data
    };

    // ── Job cost ──────────────────────────────────────────────────────────────
    let system_id = structure_profile_id
        .and_then(|id| state.input.structure_profiles.get(id))
        .and_then(|p| p.solar_system_id);

    // EIV uses total material quantities after ME.
    let mat_totals: Vec<(TypeId, u64)> = all_inputs
        .iter()
        .filter(|n| !matches!(n.kind, NodeKind::Invention(_)))
        .map(|n| (n.type_id, n.quantity_needed))
        .collect();
    let eiv_value = cost::eiv(&mat_totals, &state.input.adjusted_prices);
    let job_cost = cost::job_cost(eiv_value, bp.activity, system_id, structure_profile_id, state.input);

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
fn runs_needed(quantity: u64, output_per_run: u64) -> u32 {
    if output_per_run == 0 {
        return 0;
    }
    ((quantity + output_per_run - 1) / output_per_run) as u32
}

/// Read the actual available quantity for display, then consume up to `limit`.
/// Returns `(actual_available, consumed)`.
/// Use `actual_available` in the BuildNode's `quantity_on_hand` so the grid
/// shows real inventory rather than the amount that was merely applied to this node.
fn read_and_consume(stock: &mut HashMap<TypeId, u64>, type_id: TypeId, limit: u64) -> (u64, u64) {
    let actual = stock.get(&type_id).copied().unwrap_or(0);
    let consumed = actual.min(limit);
    if consumed > 0 {
        *stock.entry(type_id).or_insert(0) -= consumed;
    }
    (actual, consumed)
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
