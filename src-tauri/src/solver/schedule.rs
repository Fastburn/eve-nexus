// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Production schedule computation.
//!
//! Given an already-solved `BuildNode` tree and slot counts, computes how long
//! the plan will take and surfaces per-job timing breakdowns for display.
//!
//! Pure logic — no I/O, no side effects.

use crate::types::{
    BuildNode, InventionJob, ManufacturingJob, NodeKind, PlanSchedule, SolverInput, TypeId,
};

use super::cost::get_rig_te;

// ─── Skill type IDs ───────────────────────────────────────────────────────────

const SKILL_INDUSTRY: TypeId = 3380;
const SKILL_ADVANCED_INDUSTRY: TypeId = 3388;
const SKILL_LABORATORY_OPERATION: TypeId = 3359;
const SKILL_ADVANCED_LABORATORY_OPERATION: TypeId = 3403;
const SKILL_MASS_PRODUCTION: TypeId = 3387;
const SKILL_ADVANCED_MASS_PRODUCTION: TypeId = 24625;

// ─── Public API ───────────────────────────────────────────────────────────────

/// Compute a production schedule from the solved build tree.
///
/// Walks the tree, extracts all manufacturing and invention nodes, applies
/// time reductions (TE, skills, rigs), and aggregates wall-clock estimates
/// using the slot counts provided.
pub fn compute_schedule(
    nodes: &[BuildNode],
    input: &SolverInput,
    industry_slots: u32,
    science_slots: u32,
) -> PlanSchedule {
    let mut manufacturing: Vec<ManufacturingJob> = Vec::new();
    let mut invention: Vec<InventionJob> = Vec::new();

    for node in nodes {
        collect_jobs(node, input, &mut manufacturing, &mut invention);
    }

    let derived_industry_slots = derive_industry_slots(&input.character_skills);
    let derived_science_slots = derive_science_slots(&input.character_skills);

    // Wall-clock using total-slot-seconds model:
    //   total work = Σ(runs × time_per_run)
    //   wall_clock = ceil(total_work / slots)
    // This gives the correct answer when slots are optimally distributed across
    // job types, and is a good lower-bound approximation otherwise.
    let total_mfg_slot_seconds: u64 = manufacturing
        .iter()
        .map(|j| j.runs as u64 * j.time_per_run_seconds as u64)
        .sum();
    let manufacturing_wall_clock_seconds = ceil_div(total_mfg_slot_seconds, industry_slots as u64);

    let total_inv_slot_seconds: u64 = invention
        .iter()
        .map(|j| j.attempts as u64 * j.time_per_attempt_seconds as u64)
        .sum();
    let invention_wall_clock_seconds = ceil_div(total_inv_slot_seconds, science_slots as u64);

    // Invention and manufacturing can run in parallel, so critical path is
    // whichever finishes last.
    let critical_path_seconds = manufacturing_wall_clock_seconds.max(invention_wall_clock_seconds);

    PlanSchedule {
        manufacturing,
        invention,
        industry_slots,
        science_slots,
        derived_industry_slots,
        derived_science_slots,
        manufacturing_wall_clock_seconds,
        invention_wall_clock_seconds,
        critical_path_seconds,
    }
}

// ─── Tree walker ──────────────────────────────────────────────────────────────

fn collect_jobs(
    node: &BuildNode,
    input: &SolverInput,
    manufacturing: &mut Vec<ManufacturingJob>,
    invention: &mut Vec<InventionJob>,
) {
    if node.runs > 0 {
        match &node.kind {
            NodeKind::Manufacturing { te, structure_profile_id, .. } => {
                let time_per_run_seconds =
                    effective_mfg_time(node.type_id, *te, structure_profile_id.as_deref(), input);
                manufacturing.push(ManufacturingJob {
                    type_id: node.type_id,
                    type_name: node.type_name.clone(),
                    runs: node.runs,
                    time_per_run_seconds,
                });
            }
            NodeKind::Invention(inv) => {
                invention.push(InventionJob {
                    type_id: node.type_id,
                    type_name: node.type_name.clone(),
                    attempts: node.runs,
                    probability: inv.probability,
                    expected_bpcs: node.runs as f64 * inv.probability,
                    time_per_attempt_seconds: inv.time_per_attempt_seconds,
                });
            }
            _ => {}
        }
    }

    for child in &node.inputs {
        collect_jobs(child, input, manufacturing, invention);
    }
}

// ─── Time calculation ─────────────────────────────────────────────────────────

/// Effective manufacturing time per run in seconds.
///
/// Formula:
/// `base × (1 − te/100) × (1 − 0.04 × ind) × (1 − 0.03 × adv_ind) × (1 − rig_te)`
///
/// Minimum is 1 second.
pub(super) fn effective_mfg_time(
    type_id: TypeId,
    te: u8,
    structure_profile_id: Option<&str>,
    input: &SolverInput,
) -> u32 {
    let base = input.blueprints.get(&type_id).map(|bp| bp.time_seconds).unwrap_or(0);
    if base == 0 {
        return 0;
    }

    let category_id = input
        .type_summaries
        .get(&type_id)
        .map(|s| s.category_id)
        .unwrap_or(0);

    let rig_te = structure_profile_id
        .and_then(|id| input.structure_profiles.get(id))
        .map(|p| get_rig_te(p, category_id))
        .unwrap_or(0.0);

    let ind = input.character_skills.get(&SKILL_INDUSTRY).copied().unwrap_or(0) as f64;
    let adv = input.character_skills.get(&SKILL_ADVANCED_INDUSTRY).copied().unwrap_or(0) as f64;

    let eff = base as f64
        * (1.0 - te as f64 * 0.01)
        * (1.0 - 0.04 * ind)
        * (1.0 - 0.03 * adv)
        * (1.0 - rig_te);

    eff.max(1.0).ceil() as u32
}

// ─── Slot derivation ─────────────────────────────────────────────────────────

/// Industry slots = 1 + Industry + Mass Production + Advanced Mass Production
fn derive_industry_slots(skills: &std::collections::HashMap<TypeId, u8>) -> u32 {
    1 + skill(skills, SKILL_INDUSTRY) as u32
        + skill(skills, SKILL_MASS_PRODUCTION) as u32
        + skill(skills, SKILL_ADVANCED_MASS_PRODUCTION) as u32
}

/// Science/invention slots = 1 + Laboratory Operation + Advanced Laboratory Operation
fn derive_science_slots(skills: &std::collections::HashMap<TypeId, u8>) -> u32 {
    1 + skill(skills, SKILL_LABORATORY_OPERATION) as u32
        + skill(skills, SKILL_ADVANCED_LABORATORY_OPERATION) as u32
}

fn skill(skills: &std::collections::HashMap<TypeId, u8>, id: TypeId) -> u8 {
    skills.get(&id).copied().unwrap_or(0)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Integer ceiling division. Returns 0 if divisor is 0.
fn ceil_div(numerator: u64, divisor: u64) -> u64 {
    if divisor == 0 {
        return 0;
    }
    (numerator + divisor - 1) / divisor
}