//! Character auth, ESI refresh, skill/slot/job monitoring commands.

use std::collections::HashMap;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::auth::AuthState;
use crate::db::local::LocalState;
use crate::esi::{endpoints, EsiState};
use crate::types::{ActivityId, CharacterId, TypeId};

use super::CommandError;

// ─── Character management ─────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterInfo {
    pub character_id:     CharacterId,
    pub character_name:   String,
    /// "personal" | "corp" | "both"
    pub corp_assets_mode: String,
    /// True if corp asset access was confirmed on last sync (Director role).
    pub has_corp_access:  bool,
}

/// Start the OAuth2 PKCE flow. Opens the browser and waits for the callback.
/// Stores the character in the local DB on success.
#[tauri::command]
pub async fn add_character(
    app: AppHandle,
    auth: State<'_, AuthState>,
    local: State<'_, LocalState>,
) -> Result<CharacterInfo, CommandError> {
    let (character_id, character_name) = auth
        .0
        .start_auth_flow(&app)
        .await
        .map_err(|e| CommandError::InvalidInput { message: e.to_string() })?;

    let existing = local.0.get_characters().map_err(CommandError::from)?;
    if existing.iter().any(|(id, _)| *id == character_id) {
        return Err(CommandError::InvalidInput {
            message: format!("{character_name} is already added."),
        });
    }

    local
        .0
        .upsert_character(character_id, &character_name)
        .map_err(CommandError::from)?;

    Ok(CharacterInfo {
        character_id,
        character_name,
        corp_assets_mode: "personal".to_string(),
        has_corp_access: false,
    })
}

/// Remove a character and delete its stored tokens.
#[tauri::command]
pub fn remove_character(
    character_id: CharacterId,
    auth: State<'_, AuthState>,
    local: State<'_, LocalState>,
) -> Result<(), CommandError> {
    auth.0
        .remove_tokens(character_id)
        .map_err(|e| CommandError::InvalidInput { message: e.to_string() })?;
    local.0.remove_character(character_id).map_err(Into::into)
}

/// List authenticated characters stored in the local DB.
#[tauri::command]
pub fn list_characters(
    local: State<'_, LocalState>,
) -> Result<Vec<CharacterInfo>, CommandError> {
    local
        .0
        .get_characters()
        .map_err(Into::into)
        .map(|chars| {
            chars
                .into_iter()
                .map(|(id, name)| {
                    let (mode, has_corp_access) = local
                        .0
                        .get_character_extra(id)
                        .unwrap_or_else(|_| ("personal".to_string(), false));
                    CharacterInfo {
                        character_id: id,
                        character_name: name,
                        corp_assets_mode: mode,
                        has_corp_access,
                    }
                })
                .collect()
        })
}

/// Set the corp assets mode for a character: "personal" | "corp" | "both".
#[tauri::command]
pub fn set_corp_assets_mode(
    character_id: CharacterId,
    mode: String,
    local: State<'_, LocalState>,
) -> Result<(), CommandError> {
    if !["personal", "corp", "both"].contains(&mode.as_str()) {
        return Err(CommandError::InvalidInput {
            message: format!("Invalid mode: {mode}"),
        });
    }
    local.0.set_corp_assets_mode(character_id, &mode).map_err(Into::into)
}

// ─── ESI refresh ─────────────────────────────────────────────────────────────

/// Refresh ESI data for every authenticated character in the local DB.
///
/// Runs all characters in parallel; returns the first error encountered (if any).
#[tauri::command]
pub async fn refresh_all_esi_data(
    esi: State<'_, EsiState>,
    local: State<'_, LocalState>,
) -> Result<(), CommandError> {
    let characters = local.0.get_characters().map_err(CommandError::from)?;
    if characters.is_empty() {
        return Ok(());
    }

    let client = &esi.0;
    let db = &local.0;

    let _ = db.delete_cache_expiry("prices");
    let _ = db.delete_cache_expiry("cost_indices");
    for (char_id, _) in &characters {
        let _ = db.delete_cache_expiry_prefix(&format!("char:{char_id}:"));
    }
    if let Ok(regions) = db.get_market_regions() {
        for r in &regions {
            if let Some(sid) = r.structure_id {
                let _ = db.delete_cache_expiry(&format!("structure:{sid}:market"));
            }
        }
    }

    let (prices, indices) = tokio::join!(
        endpoints::fetch_adjusted_prices(client, db),
        endpoints::fetch_cost_indices(client, db),
    );
    prices.map_err(|e| CommandError::InvalidInput { message: e.to_string() })?;
    indices.map_err(|e| CommandError::InvalidInput { message: e.to_string() })?;

    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(4));
    let char_futures: Vec<_> = characters
        .iter()
        .map(|(char_id, _)| {
            let char_id = *char_id;
            let sem = sem.clone();
            let mode = db
                .get_character_extra(char_id)
                .map(|(m, _)| m)
                .unwrap_or_else(|_| "personal".to_string());
            async move {
                let _permit = sem.acquire().await.ok();
                let include_personal = mode != "corp";
                let include_corp     = mode == "corp" || mode == "both";

                let _ = endpoints::fetch_corporation_asset_structures(client, db, char_id).await;

                if include_personal {
                    let (assets, skills, jobs, blueprints, _orders) = tokio::join!(
                        endpoints::fetch_character_assets(client, db, char_id),
                        endpoints::fetch_character_skills(client, db, char_id),
                        endpoints::fetch_character_jobs(client, db, char_id),
                        endpoints::fetch_character_blueprints(client, db, char_id),
                        endpoints::fetch_character_market_orders(client, db, char_id),
                    );
                    assets.map_err(|e| CommandError::InvalidInput { message: e.to_string() })?;
                    skills.map_err(|e| CommandError::InvalidInput { message: e.to_string() })?;
                    jobs.map_err(|e| CommandError::InvalidInput { message: e.to_string() })?;
                    blueprints.map_err(|e| CommandError::InvalidInput { message: e.to_string() })?;
                }

                if include_corp {
                    let _ = endpoints::fetch_corporation_assets(client, db, char_id).await;
                    let _ = endpoints::fetch_corporation_blueprints(client, db, char_id).await;
                }

                Ok::<(), CommandError>(())
            }
        })
        .collect();

    let results = futures_util::future::join_all(char_futures).await;
    for result in results {
        result?;
    }

    // Pre-fetch structure market prices so plan solve reads from cache.
    if let Some(char_id) = characters.first().map(|(id, _)| *id) {
        if let Ok(regions) = db.get_market_regions() {
            for r in regions {
                if let Some(sid) = r.structure_id {
                    let _ = endpoints::fetch_structure_market_prices(
                        client, db, sid, char_id, &[], 3600,
                    ).await;
                }
            }
        }
    }

    Ok(())
}

/// Force-refresh all ESI data for a single character, bypassing the cache.
#[tauri::command]
pub async fn refresh_esi_data(
    character_id: CharacterId,
    esi: State<'_, EsiState>,
    local: State<'_, LocalState>,
) -> Result<(), CommandError> {
    let client = &esi.0;
    let db = &local.0;

    let _ = db.delete_cache_expiry("prices");
    let _ = db.delete_cache_expiry("cost_indices");
    let _ = db.delete_cache_expiry_prefix(&format!("char:{character_id}:"));
    let _ = db.delete_cache_expiry_prefix("corp:");
    if let Ok(regions) = db.get_market_regions() {
        for r in &regions {
            if let Some(sid) = r.structure_id {
                let _ = db.delete_cache_expiry(&format!("structure:{sid}:market"));
            }
        }
    }

    let mode = db
        .get_character_extra(character_id)
        .map(|(m, _)| m)
        .unwrap_or_else(|_| "personal".to_string());
    let include_personal = mode != "corp";
    let include_corp     = mode == "corp" || mode == "both";

    let _ = endpoints::fetch_corporation_asset_structures(client, db, character_id).await;

    let (prices, indices) = tokio::join!(
        endpoints::fetch_adjusted_prices(client, db),
        endpoints::fetch_cost_indices(client, db),
    );
    prices.map_err(|e| CommandError::InvalidInput { message: e.to_string() })?;
    indices.map_err(|e| CommandError::InvalidInput { message: e.to_string() })?;

    if include_personal {
        let (assets, skills, jobs, blueprints, _orders) = tokio::join!(
            endpoints::fetch_character_assets(client, db, character_id),
            endpoints::fetch_character_skills(client, db, character_id),
            endpoints::fetch_character_jobs(client, db, character_id),
            endpoints::fetch_character_blueprints(client, db, character_id),
            endpoints::fetch_character_market_orders(client, db, character_id),
        );
        assets.map_err(|e| CommandError::InvalidInput { message: e.to_string() })?;
        skills.map_err(|e| CommandError::InvalidInput { message: e.to_string() })?;
        jobs.map_err(|e| CommandError::InvalidInput { message: e.to_string() })?;
        blueprints.map_err(|e| CommandError::InvalidInput { message: e.to_string() })?;
    }

    if include_corp {
        let _ = endpoints::fetch_corporation_assets(client, db, character_id).await;
        let _ = endpoints::fetch_corporation_blueprints(client, db, character_id).await;
    }

    if let Ok(regions) = db.get_market_regions() {
        for r in regions {
            if let Some(sid) = r.structure_id {
                let _ = endpoints::fetch_structure_market_prices(
                    client, db, sid, character_id, &[], 3600,
                ).await;
            }
        }
    }

    Ok(())
}

// ─── Skills & slots ───────────────────────────────────────────────────────────

/// The key industry skill type IDs the advisor tracks.
const INDUSTRY_SKILL_IDS: &[TypeId] = &[
    3380,  // Industry
    3388,  // Advanced Industry
    3387,  // Mass Production
    24625, // Advanced Mass Production
    24268, // Supply Chain Management
    45746, // Reactions
    45748, // Mass Reactions
    45749, // Advanced Mass Reactions
    45750, // Remote Reactions
    3406,  // Laboratory Operation
    24624, // Advanced Laboratory Operation
    3402,  // Science
    3403,  // Research
    3409,  // Metallurgy
    24270, // Scientific Networking
    // Encryption methods — needed for invention
    21790, // Caldari Encryption Methods
    21791, // Minmatar Encryption Methods
    23087, // Amarr Encryption Methods
    23121, // Gallente Encryption Methods
     3408, // Sleeper Encryption Methods
    52308, // Triglavian Encryption Methods
    55025, // Upwell Encryption Methods
    // Science skills — affect invention probability
    11529, // Molecular Engineering
    11449, // Rocket Science
    11441, // Plasma Physics
    11433, // High Energy Physics
    11448, // Electromagnetic Physics
    11443, // Hydromagnetic Physics
    11447, // Laser Physics
    11451, // Nuclear Physics
    11452, // Mechanical Engineering (Science)
    11453, // Electronic Engineering
    11455, // Quantum Physics
    11446, // Graviton Physics
    11442, // Nanite Engineering
    // Starship engineering
    11454, // Caldari Starship Engineering
    11450, // Gallente Starship Engineering
    11444, // Amarr Starship Engineering
    11445, // Minmatar Starship Engineering
    81050, // Upwell Starship Engineering
    // Subsystem / advanced invention
    30325, // Core Subsystem Technology
    30324, // Defensive Subsystem Technology
    30327, // Offensive Subsystem Technology
    30788, // Propulsion Subsystem Technology
    52307, // Triglavian Quantum Engineering
     3400, // Outpost Construction
    22242, // Capital Ship Construction
];

/// Return the maximum skill level across all authenticated characters for each
/// key industry skill. Skills the player hasn't trained at all are omitted.
#[tauri::command]
pub fn get_industry_skills(
    local: State<'_, LocalState>,
) -> Result<HashMap<TypeId, u8>, CommandError> {
    let characters = local.0.get_characters().unwrap_or_default();
    let mut maxes: HashMap<TypeId, u8> = HashMap::new();
    for (char_id, _) in &characters {
        for (skill_id, level) in local.0.get_skills(*char_id).unwrap_or_default() {
            if INDUSTRY_SKILL_IDS.contains(&skill_id) {
                let entry = maxes.entry(skill_id).or_insert(0);
                if level > *entry {
                    *entry = level;
                }
            }
        }
    }
    Ok(maxes)
}

/// Per-character slot utilisation snapshot.
///
/// Slot caps (post-Crius):
///   Manufacturing : 1 + Mass Production + Adv Mass Production  (max 11)
///   Reaction      : 1 + Mass Reactions + Adv Mass Reactions    (max 11)
///   Research/Copy : 1 + Lab Operation + Adv Lab Op             (max 11)
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterSlotInfo {
    pub character_id:          CharacterId,
    pub character_name:        String,
    pub max_manufacturing:     u8,
    pub max_reaction:          u8,
    pub max_research:          u8,
    pub active_manufacturing:  u32,
    pub active_reaction:       u32,
    /// Research + Copying + Invention combined (all share the research pool).
    pub active_research:       u32,
}

/// Return slot capacity and current usage for every authenticated character.
#[tauri::command]
pub fn get_slot_info(
    local: State<'_, LocalState>,
) -> Result<Vec<CharacterSlotInfo>, CommandError> {
    let characters = local.0.get_characters().unwrap_or_default();
    let mut result = Vec::new();

    for (char_id, char_name) in &characters {
        let skills = local.0.get_skills(*char_id).unwrap_or_default();

        let mass_prod      = *skills.get(&3387).unwrap_or(&0);
        let adv_mass_prod  = *skills.get(&24625).unwrap_or(&0);
        let mass_react     = *skills.get(&45748).unwrap_or(&0);
        let adv_mass_react = *skills.get(&45749).unwrap_or(&0);
        let lab_op         = *skills.get(&3406).unwrap_or(&0);
        let adv_lab_op     = *skills.get(&24624).unwrap_or(&0);

        let max_manufacturing = 1 + mass_prod.min(5) + adv_mass_prod.min(5);
        let max_reaction      = 1 + mass_react.min(5) + adv_mass_react.min(5);
        let max_research      = 1 + lab_op.min(5) + adv_lab_op.min(5);

        let jobs = local.0.get_jobs(*char_id).unwrap_or_default();
        let mut active_manufacturing = 0u32;
        let mut active_reaction      = 0u32;
        let mut active_research      = 0u32;

        for job in &jobs {
            if job.end_date <= chrono::Utc::now() {
                continue;
            }
            match job.activity_id {
                ActivityId::Manufacturing              => active_manufacturing += 1,
                ActivityId::Reaction                   => active_reaction      += 1,
                ActivityId::ResearchTime
                | ActivityId::ResearchMaterial
                | ActivityId::Copying
                | ActivityId::Invention               => active_research      += 1,
            }
        }

        result.push(CharacterSlotInfo {
            character_id:        *char_id,
            character_name:       char_name.clone(),
            max_manufacturing,
            max_reaction,
            max_research,
            active_manufacturing,
            active_reaction,
            active_research,
        });
    }

    Ok(result)
}

// ─── Industry jobs ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndustryJobRow {
    pub character_id:      CharacterId,
    pub character_name:    String,
    pub job_id:            i64,
    pub blueprint_type_id: TypeId,
    pub output_type_id:    TypeId,
    pub activity_id:       ActivityId,
    pub runs:              u32,
    pub output_quantity:   u64,
    /// RFC 3339 timestamp string — easier to parse in TS than a raw DateTime.
    pub end_date: String,
}

/// Return all active industry jobs for all authenticated characters.
#[tauri::command]
pub fn list_industry_jobs(
    local: State<'_, LocalState>,
) -> Result<Vec<IndustryJobRow>, CommandError> {
    let characters = local.0.get_characters().map_err(CommandError::from)?;
    let mut rows: Vec<IndustryJobRow> = Vec::new();
    for (char_id, char_name) in &characters {
        let jobs = local.0.get_jobs(*char_id).map_err(CommandError::from)?;
        for job in jobs {
            rows.push(IndustryJobRow {
                character_id:      *char_id,
                character_name:     char_name.clone(),
                job_id:             job.job_id,
                blueprint_type_id:  job.blueprint_type_id,
                output_type_id:     job.output_type_id,
                activity_id:        job.activity_id,
                runs:               job.runs,
                output_quantity:    job.output_quantity,
                end_date:           job.end_date.to_rfc3339(),
            });
        }
    }
    rows.sort_by_key(|r| r.end_date.clone());
    Ok(rows)
}
