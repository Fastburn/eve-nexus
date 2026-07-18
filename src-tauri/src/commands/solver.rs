// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Build plan solver command — assembles SolverInput and calls the solver.

use std::collections::{HashMap, HashSet, VecDeque};

use serde::Deserialize;
use tauri::State;

use crate::db::local::LocalState;
use crate::db::sde::{SdeBlueprintInfo, SdeState};
use crate::types::{
    ActivityId, BlueprintData, BuildNode, BuildTarget, Decision, InventionBlueprint,
    SolverInput, StructureProfile, TypeId, TypeSummary,
};
use crate::solver;

use super::CommandError;

macro_rules! sde_lock {
    ($state:expr) => {
        $state.0.lock().map_err(|_| CommandError::SdeNotAvailable)?
    };
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolvePlanRequest {
    pub targets: Vec<BuildTarget>,
    #[serde(default)]
    pub me_levels: HashMap<TypeId, u8>,
    #[serde(default)]
    pub te_levels: HashMap<TypeId, u8>,
    #[serde(default)]
    pub structure_profiles: HashMap<String, StructureProfile>,
    #[serde(default)]
    pub manual_decisions: HashMap<TypeId, Decision>,
    #[serde(default)]
    pub decrypter_choices: HashMap<TypeId, TypeId>,
    #[serde(default)]
    pub blacklist: Vec<TypeId>,
}

/// Solve a build plan. Returns one `BuildNode` tree per target.
#[tauri::command]
pub fn solve_build_plan(
    request: SolvePlanRequest,
    sde: State<'_, SdeState>,
    local: State<'_, LocalState>,
) -> Result<Vec<BuildNode>, CommandError> {
    let guard = sde_lock!(sde);
    let sde_db = guard.as_ref().ok_or(CommandError::SdeNotAvailable)?;
    if request.targets.is_empty() {
        return Ok(vec![]);
    }
    let input = assemble_solver_input(request, sde_db, &local.0)?;
    Ok(solver::solve(&input))
}

/// Assemble a complete `SolverInput` from all data sources.
///
/// Shared by `solve_build_plan` and `compute_schedule` so the blueprint BFS,
/// DB reads, and ESI cache assembly are not duplicated.
pub(super) fn assemble_solver_input(
    request: SolvePlanRequest,
    sde_db: &crate::db::sde::SdeDb,
    local: &crate::db::local::LocalDb,
) -> Result<SolverInput, CommandError> {
    // ── SDE: blueprint tree ──────────────────────────────────────────────────
    let (blueprints, type_summaries) = build_blueprint_map(&request.targets, sde_db)?;

    // ── Local DB ─────────────────────────────────────────────────────────────
    let virtual_hangar = local.get_virtual_hangar()?;
    let bpc_inventory = local.get_bpc_inventory()?;
    let structure_profiles = local.get_structure_profiles()?;
    let (me_levels_db, te_levels_db) = local.get_blueprint_overrides()?;
    let manual_decisions_db = local.get_manual_decisions()?;
    let decrypter_choices_db = local.get_decrypter_choices()?;
    let blacklist_db = local.get_blacklist()?;

    // Reverse map: blueprint item type ID → product type ID.
    let bp_item_to_product: HashMap<TypeId, TypeId> = blueprints
        .iter()
        .map(|(&product_id, bp)| (bp.blueprint_type_id, product_id))
        .collect();

    // Base ME/TE from ESI-fetched owned blueprints (lowest priority).
    let mut me_levels: HashMap<TypeId, u8> = HashMap::new();
    let mut te_levels: HashMap<TypeId, u8> = HashMap::new();
    for (char_id, _) in &local.get_characters().unwrap_or_default() {
        for bp in local.get_blueprints(*char_id).unwrap_or_default() {
            if let Some(&product_id) = bp_item_to_product.get(&bp.blueprint_type_id) {
                me_levels.entry(product_id)
                    .and_modify(|v| *v = (*v).max(bp.me_level))
                    .or_insert(bp.me_level);
                te_levels.entry(product_id)
                    .and_modify(|v| *v = (*v).max(bp.te_level))
                    .or_insert(bp.te_level);
            }
        }
    }

    // Manual DB overrides take precedence over owned-blueprint values.
    me_levels.extend(me_levels_db);
    me_levels.extend(request.me_levels);
    te_levels.extend(te_levels_db);
    te_levels.extend(request.te_levels);

    let mut manual_decisions = manual_decisions_db;
    manual_decisions.extend(request.manual_decisions);

    let mut decrypter_choices = decrypter_choices_db;
    decrypter_choices.extend(request.decrypter_choices);

    let optimize_decrypters_for_time = local
        .get_setting(crate::db::local::SETTING_OPTIMIZE_DECRYPTERS_FOR_TIME)
        .unwrap_or_default()
        .as_deref()
        == Some("true");

    let mut blacklist = blacklist_db;
    blacklist.extend(request.blacklist.iter().copied());

    let mut profiles = structure_profiles;
    profiles.extend(request.structure_profiles);

    let category_ids_by_name: std::collections::HashMap<String, i32> = sde_db
        .get_industry_categories()?
        .into_iter()
        .map(|c| (c.category_name, c.category_id))
        .collect();
    for profile in profiles.values_mut() {
        if !profile.installed_rigs.is_empty() {
            profile.rig_bonuses =
                solver::rigs::expand_installed_rigs(&profile.installed_rigs, &category_ids_by_name);
        }
    }

    // ── ESI cached data (best-effort — empty maps if never fetched) ─────────
    let characters = local.get_characters().unwrap_or_default();

    let mut assets: HashMap<TypeId, u64> = HashMap::new();
    for (char_id, _) in &characters {
        for (type_id, qty) in local.get_assets(*char_id).unwrap_or_default() {
            *assets.entry(type_id).or_insert(0) += qty;
        }
    }

    let mut active_jobs: Vec<crate::types::EsiJob> = Vec::new();
    for (char_id, _) in &characters {
        for mut job in local.get_jobs(*char_id).unwrap_or_default() {
            job.output_quantity = blueprints
                .get(&job.output_type_id)
                .map(|bp| bp.output_quantity * job.runs as u64)
                .unwrap_or(job.output_quantity);
            active_jobs.push(job);
        }
    }

    let mut character_skills: HashMap<TypeId, u8> = HashMap::new();
    for (char_id, _) in &characters {
        for (skill_id, level) in local.get_skills(*char_id).unwrap_or_default() {
            let entry = character_skills.entry(skill_id).or_insert(0);
            *entry = (*entry).max(level);
        }
    }

    let adjusted_prices = local.get_adjusted_prices().unwrap_or_default();
    let cost_indices = local.get_cost_indices().unwrap_or_default();

    Ok(SolverInput {
        targets: request.targets,
        assets,
        active_jobs,
        adjusted_prices,
        cost_indices,
        virtual_hangar,
        bpc_inventory,
        structure_profiles: profiles,
        manual_decisions,
        decrypter_choices,
        optimize_decrypters_for_time,
        blacklist,
        type_summaries,
        blueprints,
        me_levels,
        te_levels,
        character_skills,
    })
}

// ─── Blueprint BFS ────────────────────────────────────────────────────────────

/// Walk the blueprint dependency tree for all targets via BFS.
/// Returns `(blueprints, type_summaries)` maps ready to insert into `SolverInput`.
pub(super) fn build_blueprint_map(
    targets: &[BuildTarget],
    sde: &crate::db::sde::SdeDb,
) -> Result<(HashMap<TypeId, BlueprintData>, HashMap<TypeId, TypeSummary>), CommandError> {
    let mut blueprints: HashMap<TypeId, BlueprintData> = HashMap::new();
    let mut type_summaries: HashMap<TypeId, TypeSummary> = HashMap::new();
    let mut queue: VecDeque<TypeId> = targets.iter().map(|t| t.type_id).collect();
    let mut visited: HashSet<TypeId> = HashSet::new();

    while let Some(type_id) = queue.pop_front() {
        if !visited.insert(type_id) {
            continue;
        }

        if let Some(info) = sde.get_type_info(type_id)? {
            type_summaries.insert(type_id, type_info_to_summary(info));
        }

        let Some((bp_type_id, activity)) = find_producing_blueprint(type_id, sde)? else {
            continue;
        };

        let bp_info = sde
            .get_blueprint_info(bp_type_id)?
            .unwrap_or(SdeBlueprintInfo {
                blueprint_type_id: bp_type_id,
                max_production_limit: 0,
            });

        let materials = sde.get_activity_materials(bp_type_id, activity)?;
        let products = sde.get_activity_products(bp_type_id, activity)?;
        let time_seconds = sde.get_activity_time(bp_type_id, activity)?.unwrap_or(0);

        let output_quantity = products
            .iter()
            .find(|p| p.product_type_id == type_id)
            .map(|p| p.quantity)
            .unwrap_or(1);

        let invention = find_invention_data(bp_type_id, sde)?;

        for mat in &materials {
            queue.push_back(mat.material_type_id);
        }
        if let Some(inv) = &invention {
            for &(dc_id, _) in &inv.datacores {
                queue.push_back(dc_id);
            }
            // Add T1 blueprint name directly to avoid BFS treating it as a buildable.
            if let Ok(Some(info)) = sde.get_type_info(inv.t1_blueprint_type_id) {
                type_summaries.insert(inv.t1_blueprint_type_id, type_info_to_summary(info));
            }
        }

        blueprints.insert(
            type_id,
            BlueprintData {
                blueprint_type_id: bp_type_id,
                activity,
                max_production_limit: bp_info.max_production_limit,
                output_quantity,
                time_seconds,
                materials: materials
                    .iter()
                    .map(|m| (m.material_type_id, m.quantity))
                    .collect(),
                invention,
            },
        );
    }

    Ok((blueprints, type_summaries))
}

fn find_producing_blueprint(
    type_id: TypeId,
    sde: &crate::db::sde::SdeDb,
) -> Result<Option<(TypeId, ActivityId)>, CommandError> {
    if let Some(id) = sde.find_blueprint_for_product(type_id, ActivityId::Manufacturing)? {
        return Ok(Some((id, ActivityId::Manufacturing)));
    }
    if let Some(id) = sde.find_blueprint_for_product(type_id, ActivityId::Reaction)? {
        return Ok(Some((id, ActivityId::Reaction)));
    }
    Ok(None)
}

fn find_invention_data(
    t2_bp_type_id: TypeId,
    sde: &crate::db::sde::SdeDb,
) -> Result<Option<InventionBlueprint>, CommandError> {
    let t1_bp_id =
        match sde.find_blueprint_for_product(t2_bp_type_id, ActivityId::Invention)? {
            Some(id) => id,
            None => return Ok(None),
        };

    let products = sde.get_activity_products(t1_bp_id, ActivityId::Invention)?;
    let output = match products.iter().find(|p| p.product_type_id == t2_bp_type_id) {
        Some(p) => p,
        None => return Ok(None),
    };

    let base_probability = output.probability.unwrap_or(0.0);

    let output_runs = sde
        .get_blueprint_info(t2_bp_type_id)?
        .map(|b| b.max_production_limit.max(1))
        .unwrap_or(1);

    let materials = sde.get_activity_materials(t1_bp_id, ActivityId::Invention)?;
    let skills = sde.get_activity_skills(t1_bp_id, ActivityId::Invention)?;
    let time_seconds = sde.get_activity_time(t1_bp_id, ActivityId::Invention)?.unwrap_or(0);

    Ok(Some(InventionBlueprint {
        t1_blueprint_type_id: t1_bp_id,
        base_probability,
        output_runs,
        output_me: 2,
        output_te: 4,
        datacores: materials.iter().map(|m| (m.material_type_id, m.quantity)).collect(),
        relevant_skill_ids: skills.iter().map(|s| s.skill_type_id).collect(),
        time_seconds,
    }))
}

fn type_info_to_summary(info: crate::db::sde::SdeTypeInfo) -> TypeSummary {
    TypeSummary {
        type_id: info.type_id,
        type_name: info.type_name,
        category_id: info.category_id,
        group_id: info.group_id,
        volume: info.volume,
    }
}