//! Market regions, price fetching, solar system cost info, restock planner,
//! and watched system commands.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::local::LocalState;
use crate::db::sde::SdeState;
use crate::esi::{endpoints, EsiState};
use crate::types::{CharacterId, SolarSystemId, TypeId};
use crate::db;

use super::CommandError;

// ─── Market regions ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_market_regions(
    local: State<'_, LocalState>,
) -> Result<Vec<db::local::MarketRegion>, CommandError> {
    Ok(local.0.get_market_regions()?)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveMarketRegionRequest {
    pub id:           String,
    pub label:        String,
    pub region_id:    i64,
    pub is_default:   bool,
    /// Set when this hub fetches prices from a player-owned structure.
    pub structure_id: Option<i64>,
}

#[tauri::command]
pub fn save_market_region(
    region: SaveMarketRegionRequest,
    local: State<'_, LocalState>,
) -> Result<(), CommandError> {
    local.0.save_market_region(&db::local::MarketRegion {
        id:           region.id,
        label:        region.label,
        region_id:    region.region_id,
        is_default:   region.is_default,
        structure_id: region.structure_id,
    })?;
    Ok(())
}

#[tauri::command]
pub fn delete_market_region(
    id: String,
    local: State<'_, LocalState>,
) -> Result<(), CommandError> {
    let regions = local.0.get_market_regions()?;
    if let Some(r) = regions.iter().find(|r| r.id == id) {
        let _ = local.0.delete_market_prices_for_region(r.region_id);
        if let Some(sid) = r.structure_id {
            let _ = local.0.delete_cache_expiry(&format!("structure:{sid}:market"));
        }
    }
    local.0.delete_market_region(&id)?;
    Ok(())
}

// ─── Market price fetching ────────────────────────────────────────────────────

/// Returned price entry — flat struct for easy frontend consumption.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPriceEntry {
    pub region_id:  i64,
    pub type_id:    TypeId,
    pub best_sell:  Option<f64>,
    pub best_buy:   Option<f64>,
    pub fetched_at: String,
}

/// Fetch (or return cached) market prices for the given type IDs across all
/// configured market regions. Cache TTL is 5 minutes.
///
/// Structure hubs use the authenticated `/markets/structures/{id}/` endpoint
/// and require at least one character to be logged in.
#[tauri::command]
pub async fn fetch_market_prices(
    type_ids: Vec<TypeId>,
    local: State<'_, LocalState>,
    esi: State<'_, EsiState>,
) -> Result<Vec<MarketPriceEntry>, CommandError> {
    if type_ids.is_empty() {
        return Ok(vec![]);
    }
    let regions = local.0.get_market_regions().map_err(CommandError::from)?;

    let characters = local.0.get_characters().map_err(CommandError::from)?;
    let character_id = characters.first().map(|(id, _)| *id);

    let mut out = Vec::new();
    for region in regions {
        let prices = if let Some(structure_id) = region.structure_id {
            if let Some(char_id) = character_id {
                endpoints::fetch_structure_market_prices(
                    &esi.0,
                    &local.0,
                    structure_id,
                    char_id,
                    &type_ids,
                    300,
                )
                .await
                .unwrap_or_default()
            } else {
                return Err(CommandError::InvalidInput {
                    message: format!(
                        "Structure market hub '{}' requires a logged-in character. Add a character in Settings > Characters.",
                        region.label
                    ),
                });
            }
        } else {
            endpoints::fetch_market_prices(
                &esi.0,
                &local.0,
                region.region_id,
                &type_ids,
                300,
            )
            .await
            .unwrap_or_default()
        };

        for p in prices {
            out.push(MarketPriceEntry {
                region_id:  p.region_id,
                type_id:    p.type_id,
                best_sell:  p.best_sell,
                best_buy:   p.best_buy,
                fetched_at: p.fetched_at.to_rfc3339(),
            });
        }
    }
    Ok(out)
}

// ─── Solar system cost info ───────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSearchResult {
    pub system_id:   SolarSystemId,
    pub system_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemCostInfo {
    pub system_id:     SolarSystemId,
    pub system_name:   String,
    pub manufacturing: Option<f64>,
    pub reaction:      Option<f64>,
    pub invention:     Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheapestSystemEntry {
    pub system_id:   SolarSystemId,
    pub system_name: String,
    pub cost_index:  f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureSearchResult {
    pub structure_id:   i64,
    pub structure_name: String,
}

/// Search solar systems by name — returns up to 20 matches.
#[tauri::command]
pub async fn search_solar_systems(
    query: String,
    local: State<'_, LocalState>,
    esi: State<'_, EsiState>,
) -> Result<Vec<SystemSearchResult>, CommandError> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let results = endpoints::search_solar_systems(&esi.0, &local.0, &query, 20)
        .await
        .map_err(|e| CommandError::InvalidInput { message: format!("ESI search failed: {e}") })?;
    Ok(results
        .into_iter()
        .map(|(id, name)| SystemSearchResult { system_id: id, system_name: name })
        .collect())
}

/// Return cost indices + cached name for one solar system.
/// If the name is not yet cached it is fetched from ESI and stored.
#[tauri::command]
pub async fn get_system_cost_info(
    system_id: SolarSystemId,
    local: State<'_, LocalState>,
    esi: State<'_, EsiState>,
) -> Result<Option<SystemCostInfo>, CommandError> {
    let names = endpoints::resolve_system_names(&esi.0, &local.0, &[system_id])
        .await
        .unwrap_or_default();
    let Some(system_name) = names.get(&system_id).cloned() else {
        return Ok(None);
    };
    let indices = local.0.get_cost_indices().map_err(CommandError::from)?;
    let ci = indices.get(&system_id);
    Ok(Some(SystemCostInfo {
        system_id,
        system_name,
        manufacturing: ci.map(|c| c.manufacturing),
        reaction:      ci.map(|c| c.reaction),
        invention:     ci.map(|c| c.invention),
    }))
}

/// Return the `limit` cheapest systems for an activity type.
/// Ensures names are resolved (from cache or ESI) before returning.
#[tauri::command]
pub async fn get_cheapest_systems(
    activity: String,
    limit: usize,
    local: State<'_, LocalState>,
    esi: State<'_, EsiState>,
) -> Result<Vec<CheapestSystemEntry>, CommandError> {
    let rows = local.0.get_cheapest_systems(&activity, limit).map_err(CommandError::from)?;

    if rows.len() < limit {
        let indices = local.0.get_cost_indices().map_err(CommandError::from)?;
        let col_key = if activity == "reaction" { "reaction" } else { "manufacturing" };
        let mut sorted: Vec<(SolarSystemId, f64)> = indices
            .iter()
            .filter_map(|(id, ci)| {
                let v = if col_key == "reaction" { ci.reaction } else { ci.manufacturing };
                if v > 0.0 { Some((*id, v)) } else { None }
            })
            .collect();
        sorted.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        let top_ids: Vec<SolarSystemId> = sorted.iter().take(limit).map(|(id, _)| *id).collect();
        let _ = endpoints::resolve_system_names(&esi.0, &local.0, &top_ids).await;
        let rows = local.0.get_cheapest_systems(&activity, limit).map_err(CommandError::from)?;
        return Ok(rows.into_iter().map(|(id, name, cost)| CheapestSystemEntry {
            system_id: id, system_name: name, cost_index: cost,
        }).collect());
    }

    Ok(rows.into_iter().map(|(id, name, cost)| CheapestSystemEntry {
        system_id: id, system_name: name, cost_index: cost,
    }).collect())
}

// ─── Structure search ─────────────────────────────────────────────────────────

/// Search market structures by name prefix.
///
/// Requires a logged-in character (for authenticated structure name resolution).
#[tauri::command]
pub async fn search_market_structures(
    query: String,
    local: State<'_, LocalState>,
    esi: State<'_, EsiState>,
) -> Result<Vec<StructureSearchResult>, CommandError> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let characters = local.0.get_characters().map_err(CommandError::from)?;
    let character_id = characters
        .first()
        .map(|(id, _)| *id)
        .ok_or_else(|| CommandError::InvalidInput {
            message: "No logged-in character — please add a character in the Characters panel first.".into(),
        })?;

    let results = endpoints::search_market_structures(&esi.0, &local.0, character_id, &query, 20)
        .await
        .map_err(|e| CommandError::InvalidInput { message: format!("Structure search failed: {e}") })?;

    Ok(results
        .into_iter()
        .map(|(id, name)| StructureSearchResult { structure_id: id, structure_name: name })
        .collect())
}

/// Return player structures where any character has assets, with resolved names.
///
/// Uses the locally cached `asset_structure_locations` table populated during
/// asset refresh. Intended for the market hub editor "quick add" suggestions.
#[tauri::command]
pub async fn get_asset_structures(
    local: State<'_, LocalState>,
    esi: State<'_, EsiState>,
) -> Result<Vec<StructureSearchResult>, CommandError> {
    let pairs = local.0.get_asset_structure_ids().map_err(CommandError::from)?;
    if pairs.is_empty() {
        return Ok(vec![]);
    }

    let mut by_structure: HashMap<i64, CharacterId> = HashMap::new();
    for (char_id, struct_id) in pairs {
        by_structure.entry(struct_id).or_insert(char_id);
    }

    let uncached: Vec<(CharacterId, i64)> = by_structure
        .iter()
        .filter(|(&struct_id, _)| {
            local.0
                .search_structure_names_prefix(&struct_id.to_string(), 1)
                .ok()
                .map(|r| r.is_empty())
                .unwrap_or(true)
        })
        .map(|(&struct_id, &char_id)| (char_id, struct_id))
        .collect();

    for (char_id, struct_id) in uncached {
        if let Ok(info) = endpoints::fetch_structure_info(&esi.0, char_id, struct_id).await {
            let _ = local.0.upsert_structure_names(&[(struct_id, info.name.as_str())]);
        }
    }

    let mut results = Vec::new();
    for &struct_id in by_structure.keys() {
        if let Ok(cached) = local.0.search_structure_names_prefix(&struct_id.to_string(), 1) {
            if let Some((sid, name)) = cached.into_iter().next() {
                results.push(StructureSearchResult { structure_id: sid, structure_name: name });
            }
        }
    }
    results.sort_by(|a, b| a.structure_name.cmp(&b.structure_name));

    Ok(results)
}

/// Diagnostic: bust asset cache and return a summary of raw location types/IDs.
/// Used to debug why asset structure detection finds nothing.
#[tauri::command]
pub async fn debug_asset_locations(
    local: State<'_, LocalState>,
    esi: State<'_, EsiState>,
) -> Result<Vec<String>, CommandError> {
    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    struct RawItem { item_id: i64, location_id: i64, location_type: String }

    let db = &local.0;
    let client = &esi.0;
    let characters = db.get_characters().map_err(CommandError::from)?;
    let mut lines: Vec<String> = vec![];

    for (char_id, name) in &characters {
        let _ = db.delete_cache_expiry(&format!("char:{char_id}:assets"));
        let path = format!("/characters/{char_id}/assets/");
        let raw: Vec<RawItem> = match client.get_auth_all_pages(&path, *char_id).await {
            Ok((r, _)) => r,
            Err(e) => { lines.push(format!("{name}: ESI error: {e}")); continue; }
        };
        lines.push(format!("{name}: {} raw items", raw.len()));

        let mut by_type: HashMap<String, usize> = HashMap::new();
        for item in &raw { *by_type.entry(item.location_type.clone()).or_insert(0) += 1; }
        let mut sorted: Vec<_> = by_type.iter().collect();
        sorted.sort_by_key(|(k, _)| k.as_str());
        for (lt, cnt) in sorted { lines.push(format!("  location_type={lt}: {cnt}")); }

        let mut player: HashMap<i64, String> = HashMap::new();
        let mut npc = 0usize;
        for item in &raw {
            if item.location_id > 1_000_000_000 {
                player.entry(item.location_id).or_insert_with(|| item.location_type.clone());
            } else if item.location_type == "station" {
                npc += 1;
            }
        }
        lines.push(format!("  NPC station items: {npc}"));
        if player.is_empty() {
            lines.push("  No player structure location_ids found (no location_id > 1B in any item)".into());
        } else {
            for (sid, lt) in &player {
                lines.push(format!("  Player structure location_id={sid} (location_type={lt})"));
            }
        }
    }
    Ok(lines)
}

// ─── Restock planner ──────────────────────────────────────────────────────────

/// One row in the restock view — target + current market position.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestockRow {
    pub type_id:          TypeId,
    pub type_name:        String,
    pub target_qty:       u64,
    pub current_sell_qty: u64,
    /// max(0, target_qty - current_sell_qty)
    pub deficit:          u64,
}

/// Fetch (or use cached) market orders for all characters, then return one
/// row per restock target with current sell quantities and deficits.
#[tauri::command]
pub async fn get_restock_rows(
    local: State<'_, LocalState>,
    esi:   State<'_, EsiState>,
    sde:   State<'_, SdeState>,
) -> Result<Vec<RestockRow>, CommandError> {
    let targets = local.0.get_restock_targets().map_err(CommandError::from)?;
    if targets.is_empty() {
        return Ok(vec![]);
    }

    let characters = local.0.get_characters().unwrap_or_default();
    for (char_id, _) in &characters {
        let _ = endpoints::fetch_character_market_orders(&esi.0, &local.0, *char_id).await;
    }

    let sell_qty = local.0.get_sell_quantities().map_err(CommandError::from)?;

    let sde_guard = sde.0.lock().map_err(|_| CommandError::SdeNotAvailable)?;

    let mut rows = Vec::with_capacity(targets.len());
    for (type_id, target_qty) in targets {
        let type_name = if let Some(db) = sde_guard.as_ref() {
            db.get_type_info(type_id)
                .ok()
                .flatten()
                .map(|i| i.type_name)
                .unwrap_or_default()
        } else {
            String::new()
        };

        let current_sell_qty = *sell_qty.get(&type_id).unwrap_or(&0);
        let deficit = target_qty.saturating_sub(current_sell_qty);

        rows.push(RestockRow { type_id, type_name, target_qty, current_sell_qty, deficit });
    }

    Ok(rows)
}

/// Upsert a restock target (create or update the target quantity).
#[tauri::command]
pub fn save_restock_target(
    type_id:    TypeId,
    target_qty: u64,
    local: State<'_, LocalState>,
) -> Result<(), CommandError> {
    local.0.upsert_restock_target(type_id, target_qty).map_err(Into::into)
}

/// Remove a restock target.
#[tauri::command]
pub fn delete_restock_target(
    type_id: TypeId,
    local: State<'_, LocalState>,
) -> Result<(), CommandError> {
    local.0.delete_restock_target(type_id).map_err(Into::into)
}

/// Return the global margin threshold (0-100, default 10.0).
#[tauri::command]
pub fn get_restock_margin(local: State<'_, LocalState>) -> Result<f64, CommandError> {
    let v = local.0
        .get_setting(db::local::SETTING_RESTOCK_MARGIN)
        .map_err(CommandError::from)?
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(10.0);
    Ok(v)
}

/// Set the global margin threshold.
#[tauri::command]
pub fn set_restock_margin(threshold: f64, local: State<'_, LocalState>) -> Result<(), CommandError> {
    local.0
        .set_setting(db::local::SETTING_RESTOCK_MARGIN, &threshold.to_string())
        .map_err(Into::into)
}

// ─── Watched systems ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchedSystemInfo {
    pub system_id:   i64,
    pub system_name: String,
    pub region_id:   Option<i64>,
}

/// Return all watched systems with resolved names and region IDs.
#[tauri::command]
pub fn get_watched_systems(
    local: State<'_, LocalState>,
) -> Result<Vec<WatchedSystemInfo>, CommandError> {
    let rows = local.0.get_watched_systems().map_err(CommandError::from)?;
    Ok(rows.into_iter().map(|r| WatchedSystemInfo {
        system_name: r.system_name.unwrap_or_else(|| format!("System {}", r.system_id)),
        system_id:   r.system_id,
        region_id:   r.region_id,
    }).collect())
}

/// Add a system to the watch list.
/// Resolves its name and region via ESI, then auto-registers the region as a
/// market hub so price fetching picks it up automatically.
#[tauri::command]
pub async fn add_watched_system(
    system_id: i64,
    local: State<'_, LocalState>,
    esi:   State<'_, EsiState>,
) -> Result<WatchedSystemInfo, CommandError> {
    let sid = system_id as SolarSystemId;

    let names = endpoints::resolve_system_names(&esi.0, &local.0, &[sid])
        .await
        .unwrap_or_default();
    let system_name = names
        .get(&sid)
        .cloned()
        .unwrap_or_else(|| format!("System {system_id}"));

    let region_id = endpoints::get_system_region(&esi.0, sid)
        .await
        .ok()
        .flatten()
        .map(|r| r as i64);

    local.0.add_watched_system(system_id, &system_name, region_id)
        .map_err(CommandError::from)?;

    // Auto-register as market hub so the market view can fetch prices.
    // INSERT OR IGNORE means hand-configured hubs are never overwritten.
    if let Some(rid) = region_id {
        let hub_id = format!("ws:{system_id}");
        local.0.try_add_market_hub(&hub_id, &system_name, rid)
            .map_err(CommandError::from)?;
    }

    Ok(WatchedSystemInfo { system_id, system_name, region_id })
}

/// Remove a system from the watch list.
#[tauri::command]
pub fn remove_watched_system(
    system_id: i64,
    local: State<'_, LocalState>,
) -> Result<(), CommandError> {
    local.0.remove_watched_system(system_id).map_err(Into::into)
}
