//! Job cost and material efficiency calculations.

use std::collections::HashMap;

use crate::types::{ActivityId, RigBonus, SolarSystemId, StructureProfile, TypeId, SolverInput};

// ─── ME / TE math ─────────────────────────────────────────────────────────────

/// Apply ME reduction to a single material across `runs` job runs.
///
/// EVE formula: `max(runs, floor(qty_per_run × runs × (1 − 0.01 × me) × (1 − rig_me)))`
///
/// `rig_me` is already pre-multiplied by the structure's space modifier.
#[must_use]
pub fn apply_me(qty_per_run: u64, runs: u32, me_level: u8, rig_me: f64) -> u64 {
    let runs_u64 = runs as u64;
    let total = qty_per_run as f64 * runs as f64;
    let bp_factor = 1.0 - (me_level as f64 * 0.01);
    let rig_factor = 1.0 - rig_me.clamp(0.0, 0.99);
    let result = (total * bp_factor * rig_factor).floor() as u64;
    result.max(runs_u64) // minimum 1 unit per run
}

/// Look up the effective rig ME bonus for a category within a structure profile.
/// Returns `bonus × space_modifier`, or `0.0` if the profile has no matching rig.
#[must_use]
pub fn get_rig_me(profile: &StructureProfile, category_id: i32) -> f64 {
    matching_rig(&profile.rig_bonuses, category_id)
        .map(|r| r.me_bonus * profile.space_modifier)
        .unwrap_or(0.0)
}

/// Look up the effective rig TE bonus for a category within a structure profile.
#[must_use]
pub fn get_rig_te(profile: &StructureProfile, category_id: i32) -> f64 {
    matching_rig(&profile.rig_bonuses, category_id)
        .map(|r| r.te_bonus * profile.space_modifier)
        .unwrap_or(0.0)
}

fn matching_rig(rigs: &[RigBonus], category_id: i32) -> Option<&RigBonus> {
    rigs.iter().find(|r| r.category_id == category_id)
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

/// Compute the EVE industry job installation cost.
///
/// EVE formula: `EIV × system_cost_index × (1 + facility_tax)`
///
/// Where:
/// - EIV (Estimated Item Value) is the sum of adjusted prices of all input materials.
///   Adjusted prices are a rolling average published by ESI, not the current market price.
///   This is CCP's mechanism to prevent cost index manipulation via cheap materials.
/// - System cost index is the fraction of total industry activity happening in that system
///   (updated by CCP daily). Busy systems cost more to install jobs in.
/// - Facility tax is the structure owner's surcharge (0–25% typically). NPC stations
///   charge a fixed 10%.
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

    let facility_tax = structure_profile_id
        .and_then(|id| input.structure_profiles.get(id))
        .map(|p| p.facility_tax)
        .unwrap_or(0.10); // Default 10% NPC tax if referenced profile was deleted.

    Some(eiv_value * index_rate * (1.0 + facility_tax))
}
