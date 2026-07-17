// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Inventory and configuration commands — virtual hangar, structure profiles,
//! blueprint ME/TE overrides, manual build/buy decisions, and the blacklist.
//!
//! These commands manage user-configured overrides that refine the solver's
//! behaviour beyond what ESI data alone can determine.

use std::collections::HashMap;
use serde::Serialize;
use tauri::State;

use crate::db::local::LocalState;
use crate::types::{BpcStockEntry, Decision, StructureProfile, TypeId};
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

// ─── BPC inventory ────────────────────────────────────────────────────────────

/// Return owned BPC stock: `type_id → { meLevel, teLevel, runsRemaining }`.
///
/// The solver consumes runs from this stock before planning fresh invention
/// attempts for that product, reducing datacore/decrypter/time cost.
#[tauri::command]
pub fn get_bpc_inventory(local: State<'_, LocalState>) -> Result<HashMap<TypeId, BpcStockEntry>, CommandError> {
    local.0.get_bpc_inventory().map_err(Into::into)
}

/// Set the BPC stock for a single product type.
/// Pass `runs_remaining = 0` to remove the entry.
#[tauri::command]
pub fn set_bpc_stock(
    type_id: TypeId,
    me_level: u8,
    te_level: u8,
    runs_remaining: u64,
    local: State<'_, LocalState>,
) -> Result<(), CommandError> {
    local.0.set_bpc_stock(type_id, me_level, te_level, runs_remaining).map_err(Into::into)
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

// ─── Decrypter choices ────────────────────────────────────────────────────────

/// A user-set decrypter override for a specific invented product type.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecrypterChoiceEntry {
    pub type_id: TypeId,
    pub decrypter_type_id: TypeId,
}

/// Return all manual decrypter overrides.
///
/// Where no override exists, the solver auto-picks the cheapest decrypter
/// (or none) for that invented product.
#[tauri::command]
pub fn get_decrypter_choices(local: State<'_, LocalState>) -> Result<Vec<DecrypterChoiceEntry>, CommandError> {
    let map = local.0.get_decrypter_choices()?;
    Ok(map
        .into_iter()
        .map(|(type_id, decrypter_type_id)| DecrypterChoiceEntry { type_id, decrypter_type_id })
        .collect())
}

/// Set a manual decrypter override for an invented product type.
#[tauri::command]
pub fn set_decrypter_choice(
    type_id: TypeId,
    decrypter_type_id: TypeId,
    local: State<'_, LocalState>,
) -> Result<(), CommandError> {
    local.0.set_decrypter_choice(type_id, decrypter_type_id).map_err(Into::into)
}

/// Remove a decrypter override, restoring automatic cheapest-decrypter selection.
#[tauri::command]
pub fn clear_decrypter_choice(
    type_id: TypeId,
    local: State<'_, LocalState>,
) -> Result<(), CommandError> {
    local.0.clear_decrypter_choice(type_id).map_err(Into::into)
}

/// A decrypter's static identity and invention modifiers, for frontend display.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecrypterSpecEntry {
    pub type_id: TypeId,
    pub name: String,
    pub run_modifier: i32,
    pub me_modifier: i32,
    pub te_modifier: i32,
    pub probability_multiplier: f64,
}

/// Return the static table of all 8 T2 decrypters, so the frontend never
/// needs to hardcode a duplicate copy of type_id/name.
#[tauri::command]
pub fn list_decrypters() -> Vec<DecrypterSpecEntry> {
    crate::solver::list_decrypters()
        .iter()
        .map(|d| DecrypterSpecEntry {
            type_id: d.type_id,
            name: d.name.to_string(),
            run_modifier: d.run_modifier,
            me_modifier: d.me_modifier,
            te_modifier: d.te_modifier,
            probability_multiplier: d.probability_multiplier,
        })
        .collect()
}

/// A structure rig's static identity, tier, and ME/TE bonus, for frontend display.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RigSpecEntry {
    pub type_id: TypeId,
    pub name: String,
    pub tier: u8,
    pub me_bonus: f64,
    pub te_bonus: f64,
    pub job_type: crate::types::JobType,
    pub category_names: Vec<String>,
}

/// Return the static table of all structure rigs, so the frontend never
/// needs to hardcode a duplicate copy of type_id/name/bonus.
#[tauri::command]
pub fn list_rigs() -> Vec<RigSpecEntry> {
    crate::solver::list_rigs()
        .iter()
        .map(|r| RigSpecEntry {
            type_id: r.type_id,
            name: r.name.to_string(),
            tier: r.tier,
            me_bonus: r.me_bonus,
            te_bonus: r.te_bonus,
            job_type: r.job_type,
            category_names: r.category_names.iter().map(|s| s.to_string()).collect(),
        })
        .collect()
}