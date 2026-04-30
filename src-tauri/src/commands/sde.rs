//! SDE-backed commands: type search, SDE status, blueprint browser.

use std::collections::HashMap;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::db::local::LocalState;
use crate::db::sde::{SdeState, SdeTypeInfo};
use crate::types::{CharacterId, TypeId, TypeSummary};
use crate::db;

use super::CommandError;

macro_rules! sde_lock {
    ($state:expr) => {
        $state.0.lock().map_err(|_| CommandError::SdeNotAvailable)?
    };
}

// ─── Type search ──────────────────────────────────────────────────────────────

/// Search published SDE types by name. Returns up to 50 results.
/// Used by the frontend type-picker autocomplete.
#[tauri::command]
pub fn search_types(
    query: String,
    sde: State<'_, SdeState>,
) -> Result<Vec<TypeSummary>, CommandError> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let guard = sde_lock!(sde);
    let db = guard.as_ref().ok_or(CommandError::SdeNotAvailable)?;
    let results = db.search_types(&query, 50)?;
    Ok(results.into_iter().map(type_info_to_summary).collect())
}

// ─── SDE status & update ─────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SdeStatus {
    pub available: bool,
}

/// Check whether the SDE is loaded and ready.
#[tauri::command]
pub fn get_sde_status(sde: State<'_, SdeState>) -> SdeStatus {
    let available = sde
        .0
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false);
    SdeStatus { available }
}

/// Trigger a manual SDE version check and update if stale.
/// After the update completes the in-memory SDE is swapped to the new file.
#[tauri::command]
pub async fn trigger_sde_update(app: AppHandle, sde: State<'_, SdeState>) -> Result<(), CommandError> {
    db::updater::check_and_update(app.clone()).await;

    if let Some(path) = db::updater::sde_db_path(&app) {
        if let Ok(new_db) = crate::db::sde::SdeDb::open(&path) {
            if let Ok(mut guard) = sde.0.lock() {
                *guard = Some(new_db);
            }
        }
    }
    Ok(())
}

/// Return the installed SDE version metadata (build number, release date).
/// Returns `None` if the SDE has not been downloaded yet.
#[tauri::command]
pub async fn get_sde_version(app: AppHandle) -> Option<db::updater::SdeVersionInfo> {
    db::updater::read_version_meta(&app).await
}

// ─── Blueprint browser ────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndustryCategory {
    pub category_id: i32,
    pub category_name: String,
    pub blueprint_count: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndustryGroup {
    pub group_id: i32,
    pub group_name: String,
    pub category_id: i32,
    pub blueprint_count: u32,
}

/// Ownership record — one per (character, blueprint_type) that the user owns.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlueprintOwnership {
    pub blueprint_type_id: TypeId,
    pub character_id: CharacterId,
    pub character_name: String,
    /// -1 = BPO; ≥ 0 = best BPC runs remaining.
    pub runs: i32,
    pub me_level: u8,
    pub te_level: u8,
}

/// One blueprint row returned from the browser — SDE data + ownership overlay.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlueprintEntry {
    pub blueprint_type_id: TypeId,
    pub blueprint_name: String,
    pub product_type_id: TypeId,
    pub product_name: String,
    pub group_id: i32,
    pub group_name: String,
    pub category_id: i32,
    pub category_name: String,
    /// 0 = unlimited (BPO); otherwise max BPC runs.
    pub max_production_limit: u32,
    /// 1 = manufacturing, 11 = reaction.
    pub activity_id: u8,
    /// Empty = blueprint not owned by any character.
    pub ownership: Vec<BlueprintOwnership>,
}

/// Return all product categories that have at least one blueprint.
#[tauri::command]
pub fn get_industry_categories(
    sde: State<'_, SdeState>,
) -> Result<Vec<IndustryCategory>, CommandError> {
    let guard = sde_lock!(sde);
    let db = guard.as_ref().ok_or(CommandError::SdeNotAvailable)?;
    let cats = db.get_industry_categories()?;
    Ok(cats
        .into_iter()
        .map(|c| IndustryCategory {
            category_id: c.category_id,
            category_name: c.category_name,
            blueprint_count: c.blueprint_count,
        })
        .collect())
}

/// Return all product groups within a category that have at least one blueprint.
#[tauri::command]
pub fn get_industry_groups(
    category_id: i32,
    sde: State<'_, SdeState>,
) -> Result<Vec<IndustryGroup>, CommandError> {
    let guard = sde_lock!(sde);
    let db = guard.as_ref().ok_or(CommandError::SdeNotAvailable)?;
    let groups = db.get_industry_groups(category_id)?;
    Ok(groups
        .into_iter()
        .map(|g| IndustryGroup {
            group_id: g.group_id,
            group_name: g.group_name,
            category_id: g.category_id,
            blueprint_count: g.blueprint_count,
        })
        .collect())
}

/// Batch-fetch type names by ID. Returns only types that exist in the SDE.
#[tauri::command]
pub fn get_type_names(
    type_ids: Vec<TypeId>,
    sde: State<'_, SdeState>,
) -> Result<HashMap<TypeId, String>, CommandError> {
    if type_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let guard = sde_lock!(sde);
    let db = guard.as_ref().ok_or(CommandError::SdeNotAvailable)?;
    let infos = db.get_type_infos(&type_ids)?;
    Ok(infos.into_iter().map(|t| (t.type_id, t.type_name)).collect())
}

/// Browse blueprints with optional category / group / text filters.
///
/// Each result includes an `ownership` array showing which characters own that
/// blueprint and their ME/TE stats. Pass `owned_only: true` to hide unowned blueprints.
#[tauri::command]
pub fn browse_blueprints(
    category_id: Option<i32>,
    group_id: Option<i32>,
    query: Option<String>,
    owned_only: bool,
    sde: State<'_, SdeState>,
    local: State<'_, LocalState>,
) -> Result<Vec<BlueprintEntry>, CommandError> {
    let guard = sde_lock!(sde);
    let db = guard.as_ref().ok_or(CommandError::SdeNotAvailable)?;

    let characters = local.0.get_characters().unwrap_or_default();
    let char_map: HashMap<CharacterId, String> = characters.into_iter().collect();

    let all_owned = local.0.get_all_blueprints().unwrap_or_default();
    let mut owned_map: HashMap<TypeId, Vec<BlueprintOwnership>> = HashMap::new();
    for (char_id, bp) in all_owned {
        if let Some(name) = char_map.get(&char_id) {
            owned_map
                .entry(bp.blueprint_type_id)
                .or_default()
                .push(BlueprintOwnership {
                    blueprint_type_id: bp.blueprint_type_id,
                    character_id: char_id,
                    character_name: name.clone(),
                    runs: bp.runs,
                    me_level: bp.me_level,
                    te_level: bp.te_level,
                });
        }
    }

    let owned_ids: Vec<TypeId> = if owned_only {
        owned_map.keys().copied().collect()
    } else {
        vec![]
    };
    let owned_filter = if owned_only && !owned_ids.is_empty() {
        Some(owned_ids.as_slice())
    } else {
        None
    };

    let limit = if query.is_some() { 200 } else { 500 };
    let entries = db.browse_blueprints(
        category_id,
        group_id,
        query.as_deref(),
        owned_filter,
        limit,
    )?;

    let mut results: Vec<BlueprintEntry> = entries
        .into_iter()
        .filter_map(|e| {
            let ownership = owned_map.remove(&e.blueprint_type_id).unwrap_or_default();
            if owned_only && ownership.is_empty() {
                return None;
            }
            Some(BlueprintEntry {
                blueprint_type_id: e.blueprint_type_id,
                blueprint_name: e.blueprint_name,
                product_type_id: e.product_type_id,
                product_name: e.product_name,
                group_id: e.group_id,
                group_name: e.group_name,
                category_id: e.category_id,
                category_name: e.category_name,
                max_production_limit: e.max_production_limit,
                activity_id: e.activity_id,
                ownership,
            })
        })
        .collect();

    // Stable sort: owned first, then alphabetical within category/group/product.
    results.sort_by(|a, b| {
        b.ownership.is_empty().cmp(&a.ownership.is_empty())
            .then_with(|| a.category_name.cmp(&b.category_name))
            .then_with(|| a.group_name.cmp(&b.group_name))
            .then_with(|| a.product_name.cmp(&b.product_name))
    });

    Ok(results)
}

/// Return all blueprints owned by all characters, each tagged with character info.
#[tauri::command]
pub fn get_character_blueprints(
    local: State<'_, LocalState>,
) -> Result<Vec<BlueprintOwnership>, CommandError> {
    let characters = local.0.get_characters().unwrap_or_default();
    let char_map: HashMap<CharacterId, String> = characters.into_iter().collect();

    let all = local.0.get_all_blueprints().map_err(CommandError::from)?;
    let result = all
        .into_iter()
        .filter_map(|(char_id, bp)| {
            let name = char_map.get(&char_id)?.clone();
            Some(BlueprintOwnership {
                blueprint_type_id: bp.blueprint_type_id,
                character_id: char_id,
                character_name: name,
                runs: bp.runs,
                me_level: bp.me_level,
                te_level: bp.te_level,
            })
        })
        .collect();
    Ok(result)
}

// ─── Conversions ──────────────────────────────────────────────────────────────

pub(super) fn type_info_to_summary(info: SdeTypeInfo) -> TypeSummary {
    TypeSummary {
        type_id: info.type_id,
        type_name: info.type_name,
        category_id: info.category_id,
        volume: info.volume,
    }
}
