// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Job cost and material efficiency calculations.

use std::collections::HashMap;

use crate::types::{ActivityId, JobType, RigBonus, SolarSystemId, StructureProfile, TypeId, SolverInput};

// ─── ME / TE math ─────────────────────────────────────────────────────────────

/// Apply ME reduction to a single material across `runs` job runs.
///
/// EVE formula: `max(runs, floor(qty_per_run × runs × (1 − 0.01 × me) × (1 − rig_me)))`
///
/// `rig_me` is the total structure reduction from [`structure_me`] (hull role
/// bonus and security-scaled rig bonus combined).
#[must_use]
pub fn apply_me(qty_per_run: u64, runs: u32, me_level: u8, rig_me: f64) -> u64 {
    let runs_u64 = runs as u64;
    let total = qty_per_run as f64 * runs as f64;
    let bp_factor = 1.0 - (me_level as f64 * 0.01);
    let rig_factor = 1.0 - rig_me.clamp(0.0, 0.99);
    let result = (total * bp_factor * rig_factor).floor() as u64;
    result.max(runs_u64) // minimum 1 unit per run
}

/// Look up the effective rig ME bonus for an item within a structure profile.
/// Returns `bonus × security multiplier`, or `0.0` if the profile has no
/// matching rig. A rig row matches when its category matches and it is
/// either category-wide or limited to the item's group.
#[must_use]
pub fn get_rig_me(profile: &StructureProfile, category_id: i32, group_id: i32) -> f64 {
    matching_rigs(&profile.rig_bonuses, category_id, group_id)
        .map(|r| r.me_bonus)
        .fold(0.0, f64::max)
        * profile.security.rig_multiplier(profile.job_type)
}

/// Look up the effective rig TE bonus for an item within a structure profile.
#[must_use]
pub fn get_rig_te(profile: &StructureProfile, category_id: i32, group_id: i32) -> f64 {
    matching_rigs(&profile.rig_bonuses, category_id, group_id)
        .map(|r| r.te_bonus)
        .fold(0.0, f64::max)
        * profile.security.rig_multiplier(profile.job_type)
}

/// Total structure material reduction: hull role bonus and rig bonus stack
/// multiplicatively, `1 − (1 − hull) × (1 − rig)`.
#[must_use]
pub fn structure_me(profile: &StructureProfile, category_id: i32, group_id: i32) -> f64 {
    let hull = profile.hull.me_bonus(profile.job_type);
    let rig = get_rig_me(profile, category_id, group_id);
    1.0 - (1.0 - hull) * (1.0 - rig)
}

/// Total structure job time reduction, stacked the same way as [`structure_me`].
#[must_use]
pub fn structure_te(profile: &StructureProfile, category_id: i32, group_id: i32) -> f64 {
    let hull = profile.hull.te_bonus(profile.job_type);
    let rig = get_rig_te(profile, category_id, group_id);
    1.0 - (1.0 - hull) * (1.0 - rig)
}

fn matching_rigs(rigs: &[RigBonus], category_id: i32, group_id: i32) -> impl Iterator<Item = &RigBonus> {
    rigs.iter()
        .filter(move |r| r.category_id == category_id && r.group_id.map_or(true, |g| g == group_id))
}

// ─── Profile resolution ───────────────────────────────────────────────────────

/// Resolve which structure profile actually applies to a node of a given
/// `job_type`.
///
/// A user's build tree typically spans multiple activities (e.g. a Manufacturing
/// target that reacts its own materials and invents its own BPCs), but only one
/// profile is ever assigned at the target level and blindly inherited by every
/// descendant node regardless of that node's own activity. This resolves the
/// correct profile per node instead:
///
/// - If the inherited `preferred` profile already matches `job_type`, use it.
/// - Otherwise, search all configured profiles for the job type: if exactly
///   one matches, use it (the common case — one profile per activity). If
///   zero or more than one match, there's no unambiguous choice, so return
///   `None` rather than guessing.
#[must_use]
pub fn resolve_profile_id<'a>(
    preferred: Option<&'a str>,
    job_type: JobType,
    profiles: &'a HashMap<String, StructureProfile>,
) -> Option<&'a str> {
    if let Some(id) = preferred {
        if profiles.get(id).map(|p| p.job_type) == Some(job_type) {
            return Some(id);
        }
    }
    let mut matches = profiles.iter().filter(|(_, p)| p.job_type == job_type);
    let first = matches.next()?;
    if matches.next().is_some() {
        return None; // ambiguous — more than one profile for this job type
    }
    Some(first.0.as_str())
}

// ─── EIV ──────────────────────────────────────────────────────────────────────

/// Estimated Item Value: sum of `adjusted_price × quantity` for a set of
/// material lines. Used as the base for the job cost formula.
#[must_use]
pub fn eiv(materials: &[(TypeId, u64)], adjusted_prices: &HashMap<TypeId, f64>) -> f64 {
    materials
        .iter()
        .map(|(type_id, qty)| {
            let price = adjusted_prices.get(type_id).copied().unwrap_or(0.0);
            price * *qty as f64
        })
        .sum()
}

// ─── Job cost ─────────────────────────────────────────────────────────────────

/// SCC surcharge added to every industry job, as a fraction of EIV.
pub const SCC_SURCHARGE: f64 = 0.04;

/// Facility tax assumed when a node's profile no longer exists: the NPC
/// station rate.
pub const NPC_FACILITY_TAX: f64 = 0.0025;

/// Compute the EVE industry job installation cost.
///
/// EVE formula:
/// `EIV × (system_cost_index × (1 − structure_job_cost_bonus) + facility_tax + SCC_SURCHARGE)`
///
/// Where:
/// - EIV (Estimated Item Value) is the sum of adjusted prices of all input materials.
///   Adjusted prices are a rolling average published by ESI, not the current market price.
///   This is CCP's mechanism to prevent cost index manipulation via cheap materials.
/// - System cost index is the fraction of total industry activity happening in that system
///   (updated by CCP daily). Busy systems cost more to install jobs in.
/// - Structure job cost bonus is the hull role bonus (Raitaru 3%, Azbel 4%,
///   Sotiyo 5%; refineries and NPC stations have none). It only discounts the
///   cost index part.
/// - Facility tax is the structure owner's rate, charged on EIV. NPC stations
///   charge 0.25%.
/// - The SCC surcharge is a flat 4% of EIV on every job.
///
/// Returns `None` if no cost index is available for the given system.
#[must_use]
pub fn job_cost(
    eiv_value: f64,
    activity: ActivityId,
    system_id: Option<SolarSystemId>,
    structure_profile_id: Option<&str>,
    input: &SolverInput,
) -> Option<f64> {
    let system_id = system_id?;
    let cost_index = input.cost_indices.get(&system_id)?;

    let index_rate = match activity {
        ActivityId::Manufacturing => cost_index.manufacturing,
        ActivityId::Reaction => cost_index.reaction,
        ActivityId::Invention => cost_index.invention,
        _ => return None,
    };

    let profile = structure_profile_id.and_then(|id| input.structure_profiles.get(id));
    let facility_tax = profile.map_or(NPC_FACILITY_TAX, |p| p.facility_tax);
    let job_cost_bonus = profile.map_or(0.0, |p| p.hull.job_cost_bonus(p.job_type));

    Some(eiv_value * (index_rate * (1.0 - job_cost_bonus) + facility_tax + SCC_SURCHARGE))
}
