//! Typed ESI endpoint functions.
//!
//! Each function checks the local DB cache before hitting the wire.
//! On a cache hit the stored data is returned immediately.
//! On a cache miss the data is fetched, stored, and the expiry updated.
//!
//! Cache keys and durations (from AGENTS.md):
//!   prices          3600 s   /markets/prices/
//!   cost_indices    3600 s   /industry/systems/
//!   char:{id}:assets  3600 s   /characters/{id}/assets/
//!   char:{id}:skills  3600 s   /characters/{id}/skills/
//!   char:{id}:jobs     300 s   /characters/{id}/industry/jobs/

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::Deserialize;

use crate::db::local::{CharacterBlueprint, LocalDb};
use crate::types::{ActivityId, CharacterId, CostIndex, EsiJob, SolarSystemId, TypeId};

use super::{EsiClient, EsiError, EsiResult};

// ─── Cache key constants ──────────────────────────────────────────────────────

const CACHE_PRICES: &str = "prices";
const CACHE_COST_INDICES: &str = "cost_indices";

fn cache_assets(id: CharacterId)        -> String { format!("char:{id}:assets") }
fn cache_corp_assets(corp_id: i64)      -> String { format!("corp:{corp_id}:assets") }
fn cache_skills(id: CharacterId)        -> String { format!("char:{id}:skills") }
fn cache_jobs(id: CharacterId)          -> String { format!("char:{id}:jobs") }
fn cache_blueprints(id: CharacterId)    -> String { format!("char:{id}:blueprints") }
fn cache_mkt_orders(id: CharacterId)   -> String { format!("char:{id}:market_orders") }

// ─── ESI response shapes ─────────────────────────────────────────────────────

/// Raw ESI blueprint item — one row per blueprint in the character's hangar.
#[derive(Debug, Deserialize)]
struct EsiBlueprintRaw {
    type_id: TypeId,
    /// -1 = BPO; positive = quantity of BPCs in the stack.
    quantity: i32,
    /// -1 = BPO (unlimited runs); positive = remaining runs on this BPC.
    runs: i32,
    material_efficiency: u8,
    time_efficiency: u8,
}

#[derive(Debug, Deserialize)]
struct EsiPrice {
    type_id: TypeId,
    adjusted_price: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct EsiCostSystem {
    solar_system_id: SolarSystemId,
    cost_indices: Vec<EsiCostIndex>,
}

#[derive(Debug, Deserialize)]
struct EsiCostIndex {
    activity: String,
    cost_index: f64,
}

#[derive(Debug, Deserialize)]
struct EsiAsset {
    item_id: i64,
    type_id: TypeId,
    quantity: u64,
    location_id: i64,
    location_type: String,
    /// "singleton" items (ships, containers) are never stacked; packaged items are.
    /// Not used for aggregation — kept for chain-walk purposes.
    #[allow(dead_code)]
    is_singleton: bool,
}

#[derive(Debug, Deserialize)]
struct EsiSkillsResponse {
    skills: Vec<EsiSkill>,
}

#[derive(Debug, Deserialize)]
struct EsiSkill {
    skill_id: TypeId,
    trained_skill_level: u8,
}

#[derive(Debug, Deserialize)]
struct EsiJobRaw {
    job_id: i64,
    blueprint_type_id: TypeId,
    product_type_id: TypeId,
    activity_id: u8,
    runs: u32,
    /// "active" | "paused" | "ready" | "delivered" | "cancelled" | "reverted"
    status: String,
    end_date: DateTime<Utc>,
    /// Structure or station where the job is installed (> 1B = player structure).
    facility_id: i64,
    #[allow(dead_code)]
    output_location_id: Option<i64>,
}

// ─── Adjusted prices ─────────────────────────────────────────────────────────

/// Fetch adjusted prices from ESI or return the cached copy.
/// Returns `type_id → adjusted_price`.
pub async fn fetch_adjusted_prices(
    client: &EsiClient,
    local: &LocalDb,
) -> EsiResult<HashMap<TypeId, f64>> {
    // Cache hit?
    if local.get_cache_expiry(CACHE_PRICES).map_err(esi_local_err)?.is_some() {
        return local.get_adjusted_prices().map_err(esi_local_err);
    }

    let (raw, expiry) = client.get_public::<Vec<EsiPrice>>("/markets/prices/").await?;

    let prices: HashMap<TypeId, f64> = raw
        .into_iter()
        .filter_map(|e| e.adjusted_price.map(|p| (e.type_id, p)))
        .collect();

    local.replace_adjusted_prices(&prices).map_err(esi_local_err)?;
    update_expiry(local, CACHE_PRICES, expiry, 3600);

    Ok(prices)
}

// ─── Industry cost indices ────────────────────────────────────────────────────

/// Fetch cost indices from ESI or return the cached copy.
pub async fn fetch_cost_indices(
    client: &EsiClient,
    local: &LocalDb,
) -> EsiResult<HashMap<SolarSystemId, CostIndex>> {
    if local.get_cache_expiry(CACHE_COST_INDICES).map_err(esi_local_err)?.is_some() {
        return local.get_cost_indices().map_err(esi_local_err);
    }

    let (raw, expiry) =
        client.get_public::<Vec<EsiCostSystem>>("/industry/systems/").await?;

    let indices: HashMap<SolarSystemId, CostIndex> = raw
        .into_iter()
        .map(|sys| {
            let mut mfg = 0.0_f64;
            let mut rxn = 0.0_f64;
            let mut inv = 0.0_f64;
            for ci in &sys.cost_indices {
                match ci.activity.as_str() {
                    "manufacturing" => mfg = ci.cost_index,
                    "reaction" => rxn = ci.cost_index,
                    "invention" => inv = ci.cost_index,
                    _ => {}
                }
            }
            (
                sys.solar_system_id,
                CostIndex {
                    solar_system_id: sys.solar_system_id,
                    manufacturing: mfg,
                    reaction: rxn,
                    invention: inv,
                },
            )
        })
        .collect();

    local.replace_cost_indices(&indices).map_err(esi_local_err)?;
    update_expiry(local, CACHE_COST_INDICES, expiry, 3600);

    Ok(indices)
}

// ─── Character assets ─────────────────────────────────────────────────────────

/// Fetch character assets and aggregate by type.
/// Only counts items in hangars (ignores fitted modules, etc.).
pub async fn fetch_character_assets(
    client: &EsiClient,
    local: &LocalDb,
    character_id: CharacterId,
) -> EsiResult<HashMap<TypeId, u64>> {
    let key = cache_assets(character_id);
    if local.get_cache_expiry(&key).map_err(esi_local_err)?.is_some() {
        return local.get_assets(character_id).map_err(esi_local_err);
    }

    let path = format!("/characters/{character_id}/assets/");
    let (raw, expiry) = client.get_auth_all_pages::<EsiAsset>(&path, character_id).await?;

    // Aggregate quantities by type, and collect player-structure IDs for hub suggestions.
    //
    // ESI location_type values:
    //   "station"      → location_id is an NPC station or player structure (directly in hangar)
    //   "item"         → location_id is the item_id of the parent container/ship
    //   "solar_system" → floating in space, ignore
    //
    // NPC station IDs are in the 60–70 M range; player structure IDs are > 1 B.
    // Items inside ships/containers have location_type "item", pointing to the
    // parent's item_id. To find which structures the character actually uses we
    // build a parent map and walk each item up to its root station location.
    let mut assets: HashMap<TypeId, u64> = HashMap::new();
    // item_id → (location_id, location_type)
    let mut parent: HashMap<i64, (i64, String)> = HashMap::with_capacity(raw.len());
    for item in &raw {
        if item.location_type != "solar_system" {
            *assets.entry(item.type_id).or_insert(0) += item.quantity;
        }
        parent.insert(item.item_id, (item.location_id, item.location_type.clone()));
    }

    // Walk each item up to its root; collect player-structure IDs.
    let mut structure_ids: std::collections::HashSet<i64> = std::collections::HashSet::new();
    for (mut loc_id, mut loc_type) in parent.values().cloned() {
        let mut depth = 0u8;
        loop {
            match loc_type.as_str() {
                // Upwell structure — always a player structure.
                "other" => { structure_ids.insert(loc_id); break; }
                // NPC station IDs are < 100M; structure IDs are > 1T.
                "station" => {
                    if loc_id > 1_000_000_000_000 {
                        structure_ids.insert(loc_id);
                    }
                    break;
                }
                "solar_system" => break,
                _ => {
                    // "item" — location_id is either another item's item_id or a
                    // structure ID. Follow the chain; if the parent isn't in our
                    // inventory but the ID is in the structure range (> 1T), capture it.
                    depth += 1;
                    if depth > 10 { break; }
                    match parent.get(&loc_id) {
                        Some((next_loc, next_type)) => {
                            loc_id = *next_loc;
                            loc_type = next_type.clone();
                        }
                        None => {
                            if loc_id > 1_000_000_000_000 {
                                structure_ids.insert(loc_id);
                            }
                            break;
                        }
                    }
                }
            }
        }
    }

    local.replace_assets(character_id, &assets).map_err(esi_local_err)?;
    let ids: Vec<i64> = structure_ids.into_iter().collect();
    local.replace_asset_structure_locations(character_id, &ids).map_err(esi_local_err)?;
    update_expiry(local, &key, expiry, 3600);

    Ok(assets)
}

// ─── Character skills ─────────────────────────────────────────────────────────

/// Fetch character skills from ESI or cache.
pub async fn fetch_character_skills(
    client: &EsiClient,
    local: &LocalDb,
    character_id: CharacterId,
) -> EsiResult<HashMap<TypeId, u8>> {
    let key = cache_skills(character_id);
    if local.get_cache_expiry(&key).map_err(esi_local_err)?.is_some() {
        return local.get_skills(character_id).map_err(esi_local_err);
    }

    let path = format!("/characters/{character_id}/skills/");
    let (resp, expiry) = client.get_auth::<EsiSkillsResponse>(&path, character_id).await?;

    let skills: HashMap<TypeId, u8> = resp
        .skills
        .into_iter()
        .map(|s| (s.skill_id, s.trained_skill_level))
        .collect();

    local.replace_skills(character_id, &skills).map_err(esi_local_err)?;
    update_expiry(local, &key, expiry, 3600);

    Ok(skills)
}

// ─── Character industry jobs ──────────────────────────────────────────────────

/// Fetch active (and recently completed) industry jobs for a character.
pub async fn fetch_character_jobs(
    client: &EsiClient,
    local: &LocalDb,
    character_id: CharacterId,
) -> EsiResult<Vec<EsiJob>> {
    let key = cache_jobs(character_id);
    if local.get_cache_expiry(&key).map_err(esi_local_err)?.is_some() {
        return local.get_jobs(character_id).map_err(esi_local_err);
    }

    let path = format!("/characters/{character_id}/industry/jobs/?include_completed=true");
    let (raw, expiry) = client.get_auth::<Vec<EsiJobRaw>>(&path, character_id).await?;

    // Collect player structure IDs from job facilities (> 1B = player structure).
    // This seeds the market hub suggestions for structures the character manufactures at.
    let job_structure_ids: Vec<i64> = raw
        .iter()
        .filter(|j| j.facility_id > 1_000_000_000)
        .map(|j| j.facility_id)
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    if !job_structure_ids.is_empty() {
        let _ = local.merge_asset_structure_locations(character_id, &job_structure_ids);
    }

    let jobs: Vec<EsiJob> = raw
        .into_iter()
        .filter_map(|j| {
            // Only include jobs whose output is still pending delivery.
            // "delivered", "cancelled", "reverted" must not count as in-progress.
            match j.status.as_str() {
                "active" | "paused" | "ready" => {}
                _ => return None,
            }

            let activity_id = match j.activity_id {
                1 => ActivityId::Manufacturing,
                3 => ActivityId::ResearchTime,
                4 => ActivityId::ResearchMaterial,
                5 => ActivityId::Copying,
                8 => ActivityId::Invention,
                11 => ActivityId::Reaction,
                _ => return None,
            };

            // output_quantity is stored as raw runs here.
            // commands/solve_build_plan multiplies by blueprint output_per_run
            // after the SDE blueprint map is built.
            Some(EsiJob {
                job_id: j.job_id,
                blueprint_type_id: j.blueprint_type_id,
                output_type_id: j.product_type_id,
                activity_id,
                runs: j.runs,
                output_quantity: j.runs as u64,
                end_date: j.end_date,
            })
        })
        .collect();

    local.replace_jobs(character_id, &jobs).map_err(esi_local_err)?;
    update_expiry(local, &key, expiry, 300);

    Ok(jobs)
}

// ─── Character blueprints ─────────────────────────────────────────────────────

/// Fetch all blueprints in a character's hangars, aggregated by blueprint type.
///
/// BPOs win over BPCs (runs = -1). Among multiple BPCs the best ME/TE is kept.
/// Cache duration follows the ESI cache header; fallback 3600 s.
pub async fn fetch_character_blueprints(
    client: &EsiClient,
    local: &LocalDb,
    character_id: CharacterId,
) -> EsiResult<Vec<CharacterBlueprint>> {
    let key = cache_blueprints(character_id);
    if local.get_cache_expiry(&key).map_err(esi_local_err)?.is_some() {
        return local.get_blueprints(character_id).map_err(esi_local_err);
    }

    let path = format!("/characters/{character_id}/blueprints/");
    let (raw, expiry) =
        client.get_auth_all_pages::<EsiBlueprintRaw>(&path, character_id).await?;

    // Aggregate: one CharacterBlueprint per type_id.
    let mut map: std::collections::HashMap<TypeId, CharacterBlueprint> =
        std::collections::HashMap::new();
    for item in raw {
        let is_bpo = item.quantity == -1 || item.runs == -1;
        let entry = map.entry(item.type_id).or_insert(CharacterBlueprint {
            blueprint_type_id: item.type_id,
            runs: if is_bpo { -1 } else { item.runs },
            me_level: item.material_efficiency,
            te_level: item.time_efficiency,
        });
        // BPO takes precedence over any BPC for the same type.
        if is_bpo {
            entry.runs = -1;
        } else if entry.runs != -1 {
            entry.runs = entry.runs.max(item.runs);
        }
        entry.me_level = entry.me_level.max(item.material_efficiency);
        entry.te_level = entry.te_level.max(item.time_efficiency);
    }

    let blueprints: Vec<CharacterBlueprint> = map.into_values().collect();
    local.replace_blueprints(character_id, &blueprints).map_err(esi_local_err)?;
    update_expiry(local, &key, expiry, 3600);

    Ok(blueprints)
}

// ─── Character market orders ──────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct EsiCharacterOrder {
    order_id:      i64,
    type_id:       TypeId,
    volume_remain: u64,
    is_buy_order:  bool,
    price:         f64,
    /// Station or player structure where the order is posted.
    location_id:   i64,
}

/// Fetch active market orders for a character and cache them.
/// Returns the number of sell orders stored.
pub async fn fetch_character_market_orders(
    client: &EsiClient,
    local: &LocalDb,
    character_id: CharacterId,
) -> EsiResult<()> {
    let key = cache_mkt_orders(character_id);
    if local.get_cache_expiry(&key).map_err(esi_local_err)?.is_some() {
        return Ok(()); // cache still valid; caller reads via get_sell_quantities()
    }

    let path = format!("/characters/{character_id}/orders/");
    let (raw, expiry) = client.get_auth::<Vec<EsiCharacterOrder>>(&path, character_id).await?;

    // Extract player structure IDs from order locations.
    let order_structure_ids: Vec<i64> = raw
        .iter()
        .filter(|o| o.location_id > 1_000_000_000)
        .map(|o| o.location_id)
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    if !order_structure_ids.is_empty() {
        let _ = local.merge_asset_structure_locations(character_id, &order_structure_ids);
    }

    let rows: Vec<crate::db::local::MarketOrderRow> = raw
        .into_iter()
        .map(|o| crate::db::local::MarketOrderRow {
            order_id:      o.order_id,
            type_id:       o.type_id,
            volume_remain: o.volume_remain,
            is_buy_order:  o.is_buy_order,
            price:         o.price,
        })
        .collect();

    local.replace_market_orders(character_id, &rows).map_err(esi_local_err)?;
    update_expiry(local, &key, expiry, 300);

    Ok(())
}

// ─── Market order prices ──────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct EsiMarketOrder {
    #[serde(rename = "type_id")]
    _type_id:      TypeId,
    is_buy_order:  bool,
    price:         f64,
    volume_remain: i64,
}

/// Full order shape returned by the structure market endpoint (includes type_id).
#[derive(Debug, Deserialize)]
struct EsiStructureOrder {
    type_id:       TypeId,
    is_buy_order:  bool,
    price:         f64,
    volume_remain: i64,
}

/// Returned by `GET /characters/{id}/` (public, no auth).
#[derive(Debug, Deserialize)]
struct EsiCharacterPublicInfo {
    corporation_id: i64,
}

/// Returned by `GET /universe/structures/{id}/`.
#[derive(Debug, Deserialize)]
pub struct EsiStructureInfo {
    pub name: String,
}

/// Returned by `GET /characters/{id}/search/?categories=structure`.
#[derive(Debug, Deserialize)]
struct EsiSearchResult {
    #[serde(default)]
    structure: Vec<i64>,
}

/// Resolve a structure's name from ESI. Requires character auth (docking access).
pub async fn fetch_structure_info(
    client: &EsiClient,
    character_id: crate::types::CharacterId,
    structure_id: i64,
) -> EsiResult<EsiStructureInfo> {
    let path = format!("/universe/structures/{structure_id}/");
    let (info, _) = client.get_auth::<EsiStructureInfo>(&path, character_id).await?;
    Ok(info)
}

/// Fetch corporation assets for the corporation the given character belongs to.
/// Extracts unique player-structure IDs (> 1 billion) and persists them so they
/// can be offered as market hub suggestions alongside the character's own assets.
///
/// Uses `esi-assets.read_corporation_assets.v1` scope via the character's token.
pub async fn fetch_corporation_asset_structures(
    client: &EsiClient,
    local: &LocalDb,
    character_id: CharacterId,
) -> EsiResult<()> {
    // Resolve corporation_id from the public character endpoint.
    let char_path = format!("/characters/{character_id}/");
    let (char_info, _) = client.get_public::<EsiCharacterPublicInfo>(&char_path).await?;
    let corp_id = char_info.corporation_id;

    // Skip if corp assets are still fresh.
    let corp_key = cache_corp_assets(corp_id);
    if local.get_cache_expiry(&corp_key).map_err(esi_local_err)?.is_some() {
        return Ok(());
    }

    let path = format!("/corporations/{corp_id}/assets/");
    let result = client.get_auth_all_pages::<EsiAsset>(&path, character_id).await;

    // Detect director access: 403 means no director role.
    match &result {
        Ok(_) => { let _ = local.set_corp_access(character_id, true); }
        Err(EsiError::HttpError { status: 403, .. }) => { let _ = local.set_corp_access(character_id, false); }
        Err(_) => {} // Network/other error — don't change access flag.
    }

    let (raw, expiry) = result?;

    // Corp asset layout (from ESI):
    //   - Office items: location_type "station", location_id = structure_id (> 1B for player structures)
    //   - Hangar contents: location_type "item", location_id = item_id of the office
    //
    // Walk the list once: anything with location_type "station" and location_id > 1B is a
    // direct player-structure hit.  Everything else with location_type "item" may be inside
    // one of those offices, but we only care about the structure ID — which we already get
    // from the office row itself.
    let mut structure_ids: std::collections::HashSet<i64> = std::collections::HashSet::new();
    for item in raw {
        if item.location_type == "other"
            || (item.location_type == "station" && item.location_id > 1_000_000_000)
        {
            structure_ids.insert(item.location_id);
        }
    }

    let ids: Vec<i64> = structure_ids.into_iter().collect();
    local.merge_asset_structure_locations(character_id, &ids).map_err(esi_local_err)?;
    update_expiry(local, &corp_key, expiry, 3600);

    Ok(())
}

/// Fetch corporation blueprints and merge into the character's blueprint inventory.
/// Requires Director role — silently skips on 403.
pub async fn fetch_corporation_blueprints(
    client: &EsiClient,
    local: &LocalDb,
    character_id: CharacterId,
) -> EsiResult<()> {
    let char_path = format!("/characters/{character_id}/");
    let (char_info, _) = client.get_public::<EsiCharacterPublicInfo>(&char_path).await?;
    let corp_id = char_info.corporation_id;

    let path = format!("/corporations/{corp_id}/blueprints/");
    let result = client.get_auth_all_pages::<EsiBlueprintRaw>(&path, character_id).await;
    let (raw, expiry) = match result {
        Ok(r) => r,
        Err(EsiError::HttpError { status: 403, .. }) => return Ok(()), // not a director
        Err(e) => return Err(e),
    };

    let mut map: std::collections::HashMap<TypeId, CharacterBlueprint> =
        std::collections::HashMap::new();
    for item in raw {
        let is_bpo = item.quantity == -1 || item.runs == -1;
        let entry = map.entry(item.type_id).or_insert(CharacterBlueprint {
            blueprint_type_id: item.type_id,
            runs: if is_bpo { -1 } else { item.runs },
            me_level: item.material_efficiency,
            te_level: item.time_efficiency,
        });
        if is_bpo { entry.runs = -1; }
        else if entry.runs != -1 { entry.runs = entry.runs.max(item.runs); }
        entry.me_level = entry.me_level.max(item.material_efficiency);
        entry.te_level = entry.te_level.max(item.time_efficiency);
    }

    let blueprints: Vec<CharacterBlueprint> = map.into_values().collect();
    // Merge corp blueprints into the character's blueprint store using upsert logic.
    local.replace_blueprints(character_id, &blueprints).map_err(esi_local_err)?;
    update_expiry(local, &format!("corp:{corp_id}:blueprints"), expiry, 3600);
    Ok(())
}

/// Fetch corporation assets and merge quantities into the character's asset inventory.
/// Requires Director role — silently skips on 403.
pub async fn fetch_corporation_assets(
    client: &EsiClient,
    local: &LocalDb,
    character_id: CharacterId,
) -> EsiResult<()> {
    let char_path = format!("/characters/{character_id}/");
    let (char_info, _) = client.get_public::<EsiCharacterPublicInfo>(&char_path).await?;
    let corp_id = char_info.corporation_id;

    let path = format!("/corporations/{corp_id}/assets/");
    let result = client.get_auth_all_pages::<EsiAsset>(&path, character_id).await;
    let (raw, _) = match result {
        Ok(r) => r,
        Err(EsiError::HttpError { status: 403, .. }) => return Ok(()),
        Err(e) => return Err(e),
    };

    // Aggregate quantities by type_id and merge into asset store.
    let mut qty_map: std::collections::HashMap<TypeId, u64> = std::collections::HashMap::new();
    for item in &raw {
        if item.location_type != "solar_system" {
            *qty_map.entry(item.type_id).or_insert(0) += item.quantity as u64;
        }
    }
    local.merge_assets(character_id, &qty_map).map_err(esi_local_err)?;
    Ok(())
}

/// Fetch best sell and buy prices for `type_ids` in `region_id`.
///
/// Prices cached in `local` are reused if younger than `max_age_secs`.
/// Stale / missing types are fetched from ESI concurrently (up to 8 at a time).
/// Returns all available prices — missing entries mean no orders exist.
pub async fn fetch_market_prices(
    client: &EsiClient,
    local: &LocalDb,
    region_id: i64,
    type_ids: &[TypeId],
    max_age_secs: i64,
) -> EsiResult<Vec<crate::db::local::MarketPrice>> {
    use crate::db::local::MarketPrice;

    let stale = local
        .get_stale_market_types(region_id, type_ids, max_age_secs)
        .map_err(esi_local_err)?;

    // Fetch stale type_ids from ESI, 8 at a time to avoid hammering the API.
    for chunk in stale.chunks(8) {
        let mut handles = Vec::new();
        for &type_id in chunk {
            let path = format!(
                "/markets/{region_id}/orders/?datasource=tranquility&order_type=all&type_id={type_id}"
            );
            handles.push((type_id, client.get_public::<Vec<EsiMarketOrder>>(&path).await));
        }
        for (type_id, result) in handles {
            let (orders, _) = match result {
                Ok(v) => v,
                Err(_) => continue, // skip on error; stale cached data (if any) stays
            };
            let best_sell = orders
                .iter()
                .filter(|o| !o.is_buy_order && o.volume_remain > 0)
                .map(|o| o.price)
                .reduce(f64::min);
            let best_buy = orders
                .iter()
                .filter(|o| o.is_buy_order && o.volume_remain > 0)
                .map(|o| o.price)
                .reduce(f64::max);
            let price = MarketPrice {
                region_id,
                type_id,
                best_sell,
                best_buy,
                fetched_at: chrono::Utc::now(),
            };
            let _ = local.replace_market_price(&price);
        }
    }

    local
        .get_market_prices(region_id, type_ids)
        .map_err(esi_local_err)
}

// ─── Structure name search ────────────────────────────────────────────────────


/// Search market structures by name or ID.
///
/// Two modes:
/// - **Numeric query**: treated as a structure ID.  Resolves the name directly
///   via `GET /universe/structures/{id}/` — works for any structure the
///   character has docking access to, including private null-sec markets.
/// - **Text query**: searches the local name cache (contains match).
///   Also fetches the public market structure list and lazily resolves names
///   for public structures not yet in the cache.
///
/// Private null-sec markets (e.g. Imperium Keepstars) are not in the public
/// list — enter the structure ID directly to add them.
pub async fn search_market_structures(
    client: &EsiClient,
    local: &LocalDb,
    character_id: crate::types::CharacterId,
    query: &str,
    limit: usize,
) -> EsiResult<Vec<(i64, String)>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(vec![]);
    }

    // ── Numeric: resolve the ID directly ─────────────────────────────────────
    if let Ok(structure_id) = query.parse::<i64>() {
        // Check local cache first.
        if let Ok(cached) = local.search_structure_names_prefix(query, 1) {
            if let Some(entry) = cached.into_iter().find(|(id, _)| *id == structure_id) {
                return Ok(vec![entry]);
            }
        }
        // Resolve from ESI (works for both public and private structures).
        let path = format!("/universe/structures/{structure_id}/");
        match client.get_auth::<EsiStructureInfo>(&path, character_id).await {
            Ok((info, _)) => {
                let _ = local.upsert_structure_names(&[(structure_id, &info.name)]);
                return Ok(vec![(structure_id, info.name)]);
            }
            Err(e) => return Err(e),
        }
    }

    // ── Text: ESI public structure search ─────────────────────────────────────
    //
    // GET /search/?categories=structure&search=... is a public endpoint (no scope).
    // It covers publicly-named structures. Private structures (e.g. null-sec coalition
    // hubs) that the character has docked at can still be added by pasting the ID.
    let esi_path = format!(
        "/search/?categories=structure&search={}&strict=false&datasource=tranquility",
        urlencoding::encode(query)
    );
    let esi_ids: Vec<i64> = match client.get_public::<EsiSearchResult>(&esi_path).await {
        Ok((result, _)) => result.structure,
        Err(_) => vec![], // ESI unreachable — degrade to local cache only
    };

    // Resolve names for any IDs not already in the local cache.
    let mut to_resolve: Vec<i64> = esi_ids
        .iter()
        .filter(|&&id| {
            local.search_structure_names_prefix(&id.to_string(), 1)
                .ok()
                .map(|r| r.is_empty())
                .unwrap_or(true)
        })
        .copied()
        .collect();
    to_resolve.truncate(limit);

    for id in to_resolve {
        let path = format!("/universe/structures/{id}/");
        if let Ok((info, _)) = client.get_auth::<EsiStructureInfo>(&path, character_id).await {
            let _ = local.upsert_structure_names(&[(id, &info.name)]);
        }
    }

    // Return from local cache (contains match over ALL cached names, not just public list).
    Ok(local.search_all_structure_names_contains(query, limit).unwrap_or_default())
}

// ─── Structure market prices ──────────────────────────────────────────────────

/// Fetch best prices from a player-owned structure market.
///
/// Unlike the regional endpoint, `/markets/structures/{id}/` returns ALL orders
/// for ALL types in one paginated stream.  We fetch every page, build a
/// type → (best_sell, best_buy) map, persist the whole batch, then return only
/// the types the caller asked for.
///
/// Prices are keyed by `structure_id` in the `market_prices` table (structure
/// IDs are in the billions; region IDs top out in the low millions — no overlap).
///
/// Returns `Vec::new()` if the character has no valid token or the structure is
/// inaccessible (e.g. not in the ACL).
pub async fn fetch_structure_market_prices(
    client: &EsiClient,
    local: &LocalDb,
    structure_id: i64,
    character_id: crate::types::CharacterId,
    type_ids: &[TypeId],
    max_age_secs: i64,
) -> EsiResult<Vec<crate::db::local::MarketPrice>> {
    use crate::db::local::MarketPrice;

    let cache_key = format!("structure:{structure_id}:market");

    // If the full fetch is still fresh, just query what we need.
    if local.get_cache_expiry(&cache_key).map_err(esi_local_err)?.is_some() {
        return local
            .get_market_prices(structure_id, type_ids)
            .map_err(esi_local_err);
    }

    // Fetch all pages (no per-type filtering on this endpoint).
    let path = format!("/markets/structures/{structure_id}/");
    let (orders, expiry) = client
        .get_auth_all_pages::<EsiStructureOrder>(&path, character_id)
        .await?;

    // Build best-price map.
    let mut price_map: std::collections::HashMap<TypeId, (Option<f64>, Option<f64>)> =
        std::collections::HashMap::new();
    for order in &orders {
        if order.volume_remain <= 0 {
            continue;
        }
        let entry = price_map.entry(order.type_id).or_insert((None, None));
        if order.is_buy_order {
            entry.1 = Some(entry.1.map_or(order.price, |b: f64| b.max(order.price)));
        } else {
            entry.0 = Some(entry.0.map_or(order.price, |b: f64| b.min(order.price)));
        }
    }

    // Persist the full batch keyed by structure_id.
    let now = chrono::Utc::now();
    for (type_id, (best_sell, best_buy)) in &price_map {
        let price = MarketPrice {
            region_id: structure_id,
            type_id:   *type_id,
            best_sell: *best_sell,
            best_buy:  *best_buy,
            fetched_at: now,
        };
        let _ = local.replace_market_price(&price);
    }

    update_expiry(local, &cache_key, expiry, max_age_secs);

    local
        .get_market_prices(structure_id, type_ids)
        .map_err(esi_local_err)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Update the cache expiry in the local DB, using the ESI `Expires` header
/// if present, otherwise falling back to `fallback_secs` from now.
fn update_expiry(local: &LocalDb, key: &str, esi_expiry: Option<DateTime<Utc>>, fallback_secs: i64) {
    let expiry = esi_expiry
        .unwrap_or_else(|| Utc::now() + chrono::Duration::seconds(fallback_secs));
    let _ = local.set_cache_expiry(key, expiry);
}

fn esi_local_err(e: crate::db::local::LocalDbError) -> EsiError {
    EsiError::HttpError {
        status: 0,
        body: format!("local DB error: {e}"),
    }
}

// ─── Solar system name resolution ─────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct EsiNameEntry {
    id: SolarSystemId,
    name: String,
    category: String,
}


/// Resolve `system_ids` to names via `POST /universe/names/`, cache results,
/// and return a map of `id → name`.  IDs already cached are skipped.
pub async fn resolve_system_names(
    client: &EsiClient,
    local: &LocalDb,
    system_ids: &[SolarSystemId],
) -> EsiResult<HashMap<SolarSystemId, String>> {
    let mut result: HashMap<SolarSystemId, String> = HashMap::new();
    let mut to_fetch: Vec<SolarSystemId> = Vec::new();

    // Use cached names where available.
    for &id in system_ids {
        match local.get_system_name(id).map_err(esi_local_err)? {
            Some(name) => { result.insert(id, name); }
            None       => { to_fetch.push(id); }
        }
    }

    if to_fetch.is_empty() {
        return Ok(result);
    }

    // ESI /universe/names/ accepts up to 1000 IDs per request.
    for chunk in to_fetch.chunks(1000) {
        let entries: Vec<EsiNameEntry> = client
            .post_public("/universe/names/", &chunk)
            .await?;

        let pairs: Vec<(SolarSystemId, &str)> = entries
            .iter()
            .filter(|e| e.category == "solar_system")
            .map(|e| (e.id, e.name.as_str()))
            .collect();

        local.upsert_system_names(&pairs).map_err(esi_local_err)?;

        for (id, name) in &pairs {
            result.insert(*id, name.to_string());
        }
    }

    Ok(result)
}

/// Search solar systems by name and return up to `limit` results as
/// `(system_id, system_name)` pairs.
///
/// Strategy (two-stage, no deprecated `/search/` endpoint):
/// 1. Prefix search against the local `system_names` cache — instant, works offline.
/// 2. Exact name lookup via `POST /universe/ids/` — handles systems not yet in the
///    cache (e.g. first time searching "C-J6MT").  Results are merged and deduped.
pub async fn search_solar_systems(
    client: &EsiClient,
    local: &LocalDb,
    query: &str,
    limit: usize,
) -> EsiResult<Vec<(SolarSystemId, String)>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(vec![]);
    }

    // Stage 1 — local cache prefix match (fast path).
    let cached = local
        .search_system_names_prefix(query, limit)
        .unwrap_or_default();

    // Stage 2 — exact name resolution via /universe/ids/.
    // Skip if a cache hit already covers the exact query string.
    let already_exact = cached.iter().any(|(_, n)| n.eq_ignore_ascii_case(query));
    let mut exact_entry: Option<(SolarSystemId, String)> = None;
    if !already_exact {
        exact_entry = resolve_exact_system_name(client, local, query).await.unwrap_or(None);
    }

    // Merge: exact match first, then cache prefix hits, deduped.
    let mut seen  = std::collections::HashSet::new();
    let mut out: Vec<(SolarSystemId, String)> = Vec::new();

    if let Some(entry) = exact_entry {
        seen.insert(entry.0);
        out.push(entry);
    }
    for entry in cached {
        if seen.insert(entry.0) {
            out.push(entry);
        }
    }

    out.truncate(limit);
    Ok(out)
}

/// Try to resolve a single exact system name via `POST /universe/ids/`.
/// Returns `None` if the name doesn't match any system.
async fn resolve_exact_system_name(
    client: &EsiClient,
    local: &LocalDb,
    name: &str,
) -> EsiResult<Option<(SolarSystemId, String)>> {
    #[derive(Deserialize)]
    struct IdEntry { id: SolarSystemId, name: String }

    #[derive(Deserialize)]
    struct IdsResponse {
        /// ESI returns solar system matches under the key "systems".
        systems: Option<Vec<IdEntry>>,
    }

    let result: IdsResponse = client
        .post_public("/universe/ids/", &[name])
        .await?;

    let Some(systems) = result.systems else {
        return Ok(None);
    };
    let Some(entry) = systems.into_iter().next() else {
        return Ok(None);
    };

    // Cache the resolved name so future prefix searches find it immediately.
    let _ = local.upsert_system_names(&[(entry.id, entry.name.as_str())]);

    Ok(Some((entry.id, entry.name)))
}

/// Resolve the region ID for a solar system via two ESI calls:
/// `GET /universe/systems/{id}/` → `constellation_id`, then
/// `GET /universe/constellations/{id}/` → `region_id`.
///
/// Returns `None` on any ESI failure (network down, unknown system, etc.).
pub async fn get_system_region(
    client: &EsiClient,
    system_id: SolarSystemId,
) -> EsiResult<Option<i32>> {
    #[derive(Deserialize)]
    struct SystemResp { constellation_id: i32 }

    #[derive(Deserialize)]
    struct ConstellationResp { region_id: i32 }

    let path = format!("/universe/systems/{system_id}/");
    let (system, _): (SystemResp, _) = client.get_public(&path).await?;

    let path2 = format!("/universe/constellations/{}/", system.constellation_id);
    let (constellation, _): (ConstellationResp, _) = client.get_public(&path2).await?;

    Ok(Some(constellation.region_id))
}
