//! Inventory and configuration commands — virtual hangar, structure profiles,
//! blueprint ME/TE overrides, manual build/buy decisions, and the blacklist.
//!
//! These commands manage user-configured overrides that refine the solver's
//! behaviour beyond what ESI data alone can determine.

use std::collections::HashMap;
use serde::Serialize;
use tauri::State;

use crate::db::local::LocalState;
use crate::types::{Decision, StructureProfile, TypeId};
use super::CommandError;

// ─── Virtual hangar ───────────────────────────────────────────────────────────

/// Return the virtual hangar stock: `type_id → quantity`.
///
/// Virtual hangar holds pre-built items the solver can consume before
/// queuing new jobs, reducing unnecessary work.
#[tauri::command]
pub fn get_virtual_hangar(local: State<'_, LocalState>) -> Result<HashMap<TypeId, u64>, CommandError> {
    local.0.get_virtual_hangar().map_err(Into::into)
}

/// Set the virtual hangar quantity for a single item type.
/// Pass `quantity = 0` to remove the entry.
#[tauri::command]
pub fn set_hangar_quantity(
    type_id: TypeId,
    quantity: u64,
    local: State<'_, LocalState>,
) -> Result<(), CommandError> {
    local.0.set_hangar_quantity(type_id, quantity).map_err(Into::into)
}

// ─── Structure profiles ───────────────────────────────────────────────────────

/// Return all saved structure profiles.
///
/// Profiles describe a manufacturing/reaction structure's location, tax, and
/// rig bonuses. The solver uses these to compute accurate job costs and
/// ME/TE reductions.
#[tauri::command]
pub fn get_structure_profiles(local: State<'_, LocalState>) -> Result<Vec<StructureProfile>, CommandError> {
    let profiles = local.0.get_structure_profiles()?;
    Ok(profiles.into_values().collect())
}

/// Create or update a structure profile (matched by `profile.id`).
#[tauri::command]
pub fn save_structure_profile(
    profile: StructureProfile,
    local: State<'_, LocalState>,
) -> Result<(), CommandError> {
    local.0.save_structure_profile(&profile).map_err(Into::into)
}

/// Permanently delete a structure profile by ID.
#[tauri::command]
pub fn delete_structure_profile(
    id: String,
    local: State<'_, LocalState>,
) -> Result<(), CommandError> {
    local.0.delete_structure_profile(&id).map_err(Into::into)
}

// ─── Blueprint overrides ──────────────────────────────────────────────────────

/// A user-configured ME/TE override for a specific blueprint type.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlueprintOverrideEntry {
    pub type_id:  TypeId,
    pub me_level: u8,
    pub te_level: u8,
}

/// Return all per-type blueprint ME/TE overrides.
///
/// Where no override exists, the solver uses its defaults (ME10/TE20 for
/// owned BPOs, ME0/TE0 for BPCs without research data).
#[tauri::command]
pub fn get_blueprint_overrides(
    local: State<'_, LocalState>,
) -> Result<Vec<BlueprintOverrideEntry>, CommandError> {
    let (me_map, te_map) = local.0.get_blueprint_overrides()?;
    let entries = me_map
        .into_iter()
        .map(|(type_id, me_level)| BlueprintOverrideEntry {
            type_id,
            me_level,
            te_level: te_map.get(&type_id).copied().unwrap_or(20),
        })
        .collect();
    Ok(entries)
}

/// Set ME/TE levels for a blueprint type. Both are clamped 0–20 (EVE max).
///
/// ME reduces material requirements; TE reduces job time. These are per-level
/// percentages: ME10 = 10% fewer materials, TE20 = 20% shorter jobs.
#[tauri::command]
pub fn set_blueprint_override(
    type_id: TypeId,
    me_level: u8,
    te_level: u8,
    local: State<'_, LocalState>,
) -> Result<(), CommandError> {
    if me_level > 20 || te_level > 20 {
        return Err(CommandError::InvalidInput {
            message: format!("ME/TE levels must be 0-20 (got ME={me_level}, TE={te_level})"),
        });
    }
    local.0.set_blueprint_override(type_id, me_level, te_level).map_err(Into::into)
}

/// Remove a blueprint ME/TE override, reverting to solver defaults.
#[tauri::command]
pub fn clear_blueprint_override(
    type_id: TypeId,
    local: State<'_, LocalState>,
) -> Result<(), CommandError> {
    local.0.clear_blueprint_override(type_id).map_err(Into::into)
}

// ─── Manual decisions & blacklist ─────────────────────────────────────────────

/// A user-set build/buy decision for a specific item type.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualDecisionEntry {
    pub type_id:  TypeId,
    pub decision: Decision,
}

/// Return all manual build/buy overrides.
///
/// Manual decisions take precedence over the solver's automatic buy-vs-build
/// analysis, letting users lock specific intermediates to always buy or build.
#[tauri::command]
pub fn get_manual_decisions(local: State<'_, LocalState>) -> Result<Vec<ManualDecisionEntry>, CommandError> {
    let map = local.0.get_manual_decisions()?;
    Ok(map
        .into_iter()
        .map(|(type_id, decision)| ManualDecisionEntry { type_id, decision })
        .collect())
}

/// Set a manual build/buy decision for an item type.
#[tauri::command]
pub fn set_manual_decision(
    type_id: TypeId,
    decision: Decision,
    local: State<'_, LocalState>,
) -> Result<(), CommandError> {
    local.0.set_manual_decision(type_id, decision).map_err(Into::into)
}

/// Remove a manual decision, restoring automatic buy-vs-build analysis.
#[tauri::command]
pub fn clear_manual_decision(
    type_id: TypeId,
    local: State<'_, LocalState>,
) -> Result<(), CommandError> {
    local.0.clear_manual_decision(type_id).map_err(Into::into)
}

/// Return all blacklisted type IDs.
///
/// Blacklisted items are never built by the solver — always sourced by buying.
/// Useful for items that are cheaper to buy than to manufacture.
#[tauri::command]
pub fn get_blacklist(local: State<'_, LocalState>) -> Result<Vec<TypeId>, CommandError> {
    local.0.get_blacklist()
        .map(|set| set.into_iter().collect())
        .map_err(Into::into)
}

/// Add an item to the blacklist.
#[tauri::command]
pub fn add_to_blacklist(type_id: TypeId, local: State<'_, LocalState>) -> Result<(), CommandError> {
    local.0.add_to_blacklist(type_id).map_err(Into::into)
}

/// Remove an item from the blacklist, allowing the solver to build it again.
#[tauri::command]
pub fn remove_from_blacklist(type_id: TypeId, local: State<'_, LocalState>) -> Result<(), CommandError> {
    local.0.remove_from_blacklist(type_id).map_err(Into::into)
}
