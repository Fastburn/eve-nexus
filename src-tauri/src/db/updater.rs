//! SDE version check and background update.
//!
//! On launch, checks CCP's version endpoint and downloads a fresh copy of the
//! SDE if the local build is stale. The SDE is distributed by CCP as a JSONL
//! zip; we extract the tables we need and import them into a local SQLite file
//! so the rest of the app can query it with plain SQL.
//!
//! Two separate concerns — do not conflate:
//! - App updates: Tauri built-in updater.
//! - SDE updates: this module.

use std::io::{Cursor, Read};
use std::path::PathBuf;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use reqwest::Client;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

// ─── CCP endpoints ────────────────────────────────────────────────────────────

const VERSION_URL: &str =
    "https://developers.eveonline.com/static-data/tranquility/latest.jsonl";

const DOWNLOAD_URL: &str =
    "https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip";

/// Filename of the built SDE SQLite database in the app data directory.
pub const SDE_DB_FILENAME: &str = "sde.sqlite";

const VERSION_META_FILENAME: &str = "sde-version.json";
const TEMP_ZIP_FILENAME: &str = "sde-download.zip.tmp";

// ─── CCP version response ─────────────────────────────────────────────────────

/// Parsed from `latest.jsonl` — CCP's version endpoint.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CcpVersion {
    build_number: u64,
    release_date: DateTime<Utc>,
}

// ─── Local metadata ───────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SdeVersionMeta {
    build_number: u64,
    release_date: DateTime<Utc>,
    imported_at: DateTime<Utc>,
}

// ─── SDE import steps ─────────────────────────────────────────────────────────

/// Number of logical import steps — used for progress reporting.
/// Steps: types, groups, categories, blueprints.
const TOTAL_IMPORT_STEPS: usize = 4;

// ─── Public result type ───────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SdeUpdateResult {
    AlreadyCurrent { build_number: u64 },
    Updated { build_number: u64 },
    /// Non-fatal: the app continues with whatever SDE is already installed.
    Failed { reason: String },
}

// ─── Event payloads ───────────────────────────────────────────────────────────

/// Emitted on `"sde://progress"` while the zip is downloading.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub bytes_received: u64,
    pub bytes_total: Option<u64>,
}

/// Emitted on `"sde://import-progress"` while JSONL tables are being imported.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub table: String,
    pub tables_done: usize,
    pub tables_total: usize,
}

// ─── Update lock ─────────────────────────────────────────────────────────────

// Serializes concurrent calls to check_and_update. Both the auto-launch
// background task and the user-triggered command write to the same temp files,
// so they must not run simultaneously.
static SDE_UPDATE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// ─── Entry point ─────────────────────────────────────────────────────────────

/// Check CCP's version endpoint and import a fresh SDE if the local copy is
/// stale. Intended to be spawned with `tokio::spawn` on app launch.
///
/// Frontend events:
///
/// | Event                  | Payload              |
/// |------------------------|----------------------|
/// | `sde://progress`       | `DownloadProgress`   |
/// | `sde://import-progress`| `ImportProgress`     |
/// | `sde://result`         | `SdeUpdateResult`    |
pub async fn check_and_update(app: AppHandle) {
    let _guard = SDE_UPDATE_LOCK.lock().await;
    let result = run(&app).await.unwrap_or_else(|e| SdeUpdateResult::Failed {
        reason: e.to_string(),
    });
    let _ = app.emit("sde://result", &result);
}

// ─── Internal implementation ──────────────────────────────────────────────────

async fn run(app: &AppHandle) -> Result<SdeUpdateResult> {
    let data_dir = app
        .path()
        .app_data_dir()
        .context("could not resolve app data directory")?;

    let result = run_inner(app, &data_dir).await;

    // On any failure, clean up temp files so the next run starts fresh.
    if result.is_err() {
        let _ = tokio::fs::remove_file(data_dir.join(TEMP_ZIP_FILENAME)).await;
        let _ = tokio::fs::remove_file(data_dir.join("sde.sqlite.tmp")).await;
    }

    result
}

async fn run_inner(app: &AppHandle, data_dir: &std::path::PathBuf) -> Result<SdeUpdateResult> {
    let data_dir = data_dir.clone();

    tokio::fs::create_dir_all(&data_dir)
        .await
        .context("could not create app data directory")?;

    let client = Client::builder()
        .user_agent(concat!(
            "EveNexus/",
            env!("CARGO_PKG_VERSION"),
            " (https://github.com/fastburn/eve-nexus)"
        ))
        .build()
        .context("could not build HTTP client")?;

    // ── 1. Check remote version ──────────────────────────────────────────────
    let remote = fetch_version(&client).await?;

    // ── 2. Compare against local version ────────────────────────────────────
    // Also verify the database file itself exists — a missing file with stale
    // version metadata (e.g. after manual deletion) must still trigger a download.
    let meta_path = data_dir.join(VERSION_META_FILENAME);
    let db_path   = data_dir.join(SDE_DB_FILENAME);
    if let Some(local) = load_version_meta(&meta_path).await {
        if local.build_number == remote.build_number && db_path.exists() {
            return Ok(SdeUpdateResult::AlreadyCurrent {
                build_number: local.build_number,
            });
        }
    }

    // ── 3. Clean up any stale temp files from a prior crashed run ────────────
    let _ = tokio::fs::remove_file(data_dir.join(TEMP_ZIP_FILENAME)).await;
    let _ = tokio::fs::remove_file(data_dir.join("sde.sqlite.tmp")).await;

    // ── 4. Download + import with up to 3 attempts ───────────────────────────
    const MAX_ATTEMPTS: u32 = 3;
    let mut last_err: Option<anyhow::Error> = None;
    for attempt in 1..=MAX_ATTEMPTS {
        match try_download_and_import(&client, app, &data_dir).await {
            Ok(()) => { last_err = None; break; }
            Err(e) => {
                let _ = tokio::fs::remove_file(data_dir.join(TEMP_ZIP_FILENAME)).await;
                let _ = tokio::fs::remove_file(data_dir.join("sde.sqlite.tmp")).await;
                if attempt < MAX_ATTEMPTS {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                }
                last_err = Some(e);
            }
        }
    }
    if let Some(e) = last_err {
        return Err(e);
    }

    // ── 5. Persist version metadata ──────────────────────────────────────────
    let meta = SdeVersionMeta {
        build_number: remote.build_number,
        release_date: remote.release_date,
        imported_at: Utc::now(),
    };
    tokio::fs::write(&meta_path, serde_json::to_string_pretty(&meta)?)
        .await
        .context("could not write version metadata")?;

    Ok(SdeUpdateResult::Updated {
        build_number: remote.build_number,
    })
}

async fn try_download_and_import(
    client: &Client,
    app: &AppHandle,
    data_dir: &PathBuf,
) -> Result<()> {
    // ── Download the JSONL zip ────────────────────────────────────────────────
    let zip_path = data_dir.join(TEMP_ZIP_FILENAME);
    download_zip(client, app, &zip_path).await?;

    // ── Import required tables into a fresh SQLite file ───────────────────────
    let sde_tmp = data_dir.join("sde.sqlite.tmp");
    let zip_bytes = tokio::fs::read(&zip_path)
        .await
        .context("could not read downloaded zip")?;

    let tables_total = TOTAL_IMPORT_STEPS;
    let app_clone = app.clone();
    let sde_tmp_import = sde_tmp.clone();
    tokio::task::spawn_blocking(move || {
        import_tables(&zip_bytes, &sde_tmp_import, |table, tables_done| {
            let _ = app_clone.emit(
                "sde://import-progress",
                ImportProgress {
                    table: table.to_string(),
                    tables_done,
                    tables_total,
                },
            );
        })
    })
    .await
    .context("import task panicked")??;

    // ── Verify integrity before swapping ─────────────────────────────────────
    // CCP does not publish checksums, so use SQLite's built-in integrity check.
    let sde_tmp_verify = sde_tmp.clone();
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&sde_tmp_verify)
            .context("could not open built SDE for verification")?;
        let result: String = conn
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .context("integrity_check query failed")?;
        if result != "ok" {
            anyhow::bail!("SDE integrity check failed: {result}");
        }
        Ok::<(), anyhow::Error>(())
    })
    .await
    .context("integrity check task panicked")??;

    // ── Clean up zip, atomic swap ─────────────────────────────────────────────
    let _ = tokio::fs::remove_file(&zip_path).await;
    let sde_path = data_dir.join(SDE_DB_FILENAME);
    tokio::fs::rename(&sde_tmp, &sde_path)
        .await
        .context("could not move built SDE into place")?;

    Ok(())
}

async fn fetch_version(client: &Client) -> Result<CcpVersion> {
    client
        .get(VERSION_URL)
        .send()
        .await
        .context("version check request failed")?
        .error_for_status()
        .context("version endpoint returned non-2xx")?
        .json::<CcpVersion>()
        .await
        .context("could not parse version response")
}

async fn load_version_meta(path: &PathBuf) -> Option<SdeVersionMeta> {
    let bytes = tokio::fs::read(path).await.ok()?;
    serde_json::from_slice(&bytes).ok()
}

async fn download_zip(client: &Client, app: &AppHandle, dest: &PathBuf) -> Result<()> {
    use futures_util::StreamExt;

    let response = client
        .get(DOWNLOAD_URL)
        .send()
        .await
        .context("SDE download request failed")?
        .error_for_status()
        .context("SDE download returned non-2xx")?;

    let bytes_total = response.content_length();
    let mut file = tokio::fs::File::create(dest)
        .await
        .context("could not create temp zip file")?;

    let mut stream = response.bytes_stream();
    let mut bytes_received: u64 = 0;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("error reading download stream")?;
        file.write_all(&chunk)
            .await
            .context("error writing zip chunk")?;
        bytes_received += chunk.len() as u64;
        let _ = app.emit(
            "sde://progress",
            DownloadProgress {
                bytes_received,
                bytes_total,
            },
        );
    }

    file.flush().await.context("could not flush zip file")?;
    Ok(())
}

/// Extract and import SDE data from `zip_bytes` into a fresh SQLite database
/// at `dest`. Creates the classic schema (invTypes, invGroups, invCategories,
/// industryBlueprints, industryActivities, industryActivity*) from CCP's
/// newer JSONL format (types.jsonl, groups.jsonl, categories.jsonl,
/// blueprints.jsonl). `on_progress` is called after each of the 4 steps.
fn import_tables(
    zip_bytes: &[u8],
    dest: &PathBuf,
    mut on_progress: impl FnMut(&str, usize),
) -> Result<()> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(zip_bytes)).context("could not open zip archive")?;

    // ── Read the four source files from the zip ───────────────────────────────
    let mut types_content = None::<String>;
    let mut groups_content = None::<String>;
    let mut categories_content = None::<String>;
    let mut blueprints_content = None::<String>;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).context("could not read zip entry")?;
        let name = entry.name().to_string();
        let target = if name == "types.jsonl" {
            &mut types_content
        } else if name == "groups.jsonl" {
            &mut groups_content
        } else if name == "categories.jsonl" {
            &mut categories_content
        } else if name == "blueprints.jsonl" {
            &mut blueprints_content
        } else {
            continue;
        };
        let mut content = String::new();
        entry.read_to_string(&mut content).context("could not read zip entry")?;
        *target = Some(content);
    }

    let conn = Connection::open(dest).context("could not create SDE SQLite file")?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
        .context("could not set SQLite pragmas")?;

    let types_content = types_content.context("types.jsonl not found in SDE zip")?;
    import_types(&conn, &types_content).context("failed to import types")?;
    on_progress("invTypes", 1);

    let groups_content = groups_content.context("groups.jsonl not found in SDE zip")?;
    import_groups(&conn, &groups_content).context("failed to import groups")?;
    on_progress("invGroups", 2);

    let categories_content = categories_content.context("categories.jsonl not found in SDE zip")?;
    import_categories(&conn, &categories_content).context("failed to import categories")?;
    on_progress("invCategories", 3);

    let blueprints_content = blueprints_content.context("blueprints.jsonl not found in SDE zip")?;
    import_blueprints(&conn, &blueprints_content).context("failed to import blueprints")?;
    on_progress("blueprints", 4);

    Ok(())
}

// ─── Per-file importers ───────────────────────────────────────────────────────

/// types.jsonl → invTypes(typeID, typeName, groupID, portionSize, published, volume)
fn import_types(conn: &Connection, content: &str) -> Result<()> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS invTypes;
         CREATE TABLE invTypes (
             typeID INTEGER, typeName TEXT, groupID INTEGER,
             portionSize INTEGER, published TEXT, volume REAL
         );",
    )?;
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO invTypes (typeID, typeName, groupID, portionSize, published, volume)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for line in content.lines().filter(|l| !l.trim().is_empty()) {
            let obj: serde_json::Map<String, serde_json::Value> =
                serde_json::from_str(line).context("invalid types line")?;
            let type_id = key_as_i64(&obj)?;
            let type_name = localized_name(&obj);
            let group_id = obj.get("groupID").and_then(|v| v.as_i64()).unwrap_or(0);
            let portion_size = obj.get("portionSize").and_then(|v| v.as_i64()).unwrap_or(1);
            let published = if obj.get("published").and_then(|v| v.as_bool()).unwrap_or(false) {
                "1"
            } else {
                "0"
            };
            let volume = obj.get("volume").and_then(|v| v.as_f64()).unwrap_or(0.0);
            stmt.execute(rusqlite::params![
                type_id, type_name, group_id, portion_size, published, volume
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// groups.jsonl → invGroups(groupID, groupName, categoryID)
fn import_groups(conn: &Connection, content: &str) -> Result<()> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS invGroups;
         CREATE TABLE invGroups (groupID INTEGER, groupName TEXT, categoryID INTEGER);",
    )?;
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO invGroups (groupID, groupName, categoryID) VALUES (?1, ?2, ?3)",
        )?;
        for line in content.lines().filter(|l| !l.trim().is_empty()) {
            let obj: serde_json::Map<String, serde_json::Value> =
                serde_json::from_str(line).context("invalid groups line")?;
            let group_id = key_as_i64(&obj)?;
            let group_name = localized_name(&obj);
            let category_id = obj.get("categoryID").and_then(|v| v.as_i64()).unwrap_or(0);
            stmt.execute(rusqlite::params![group_id, group_name, category_id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// categories.jsonl → invCategories(categoryID, categoryName)
fn import_categories(conn: &Connection, content: &str) -> Result<()> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS invCategories;
         CREATE TABLE invCategories (categoryID INTEGER, categoryName TEXT);",
    )?;
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO invCategories (categoryID, categoryName) VALUES (?1, ?2)",
        )?;
        for line in content.lines().filter(|l| !l.trim().is_empty()) {
            let obj: serde_json::Map<String, serde_json::Value> =
                serde_json::from_str(line).context("invalid categories line")?;
            let category_id = key_as_i64(&obj)?;
            let category_name = localized_name(&obj);
            stmt.execute(rusqlite::params![category_id, category_name])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// blueprints.jsonl → industryBlueprints, industryActivities,
/// industryActivityMaterials, industryActivityProducts, industryActivitySkills
fn import_blueprints(conn: &Connection, content: &str) -> Result<()> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS industryBlueprints;
         CREATE TABLE industryBlueprints (blueprintTypeID INTEGER, maxProductionLimit INTEGER);

         DROP TABLE IF EXISTS industryActivities;
         CREATE TABLE industryActivities (blueprintTypeID INTEGER, activityID INTEGER, time INTEGER);

         DROP TABLE IF EXISTS industryActivityMaterials;
         CREATE TABLE industryActivityMaterials (
             blueprintTypeID INTEGER, activityID INTEGER,
             materialTypeID INTEGER, quantity INTEGER
         );

         DROP TABLE IF EXISTS industryActivityProducts;
         CREATE TABLE industryActivityProducts (
             blueprintTypeID INTEGER, activityID INTEGER,
             productTypeID INTEGER, quantity INTEGER, probability REAL
         );

         DROP TABLE IF EXISTS industryActivitySkills;
         CREATE TABLE industryActivitySkills (
             blueprintTypeID INTEGER, activityID INTEGER,
             skillTypeID INTEGER, level INTEGER
         );",
    )?;

    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt_bp = tx.prepare(
            "INSERT INTO industryBlueprints (blueprintTypeID, maxProductionLimit) VALUES (?1, ?2)",
        )?;
        let mut stmt_act = tx.prepare(
            "INSERT INTO industryActivities (blueprintTypeID, activityID, time) VALUES (?1, ?2, ?3)",
        )?;
        let mut stmt_mat = tx.prepare(
            "INSERT INTO industryActivityMaterials
             (blueprintTypeID, activityID, materialTypeID, quantity) VALUES (?1, ?2, ?3, ?4)",
        )?;
        let mut stmt_prod = tx.prepare(
            "INSERT INTO industryActivityProducts
             (blueprintTypeID, activityID, productTypeID, quantity, probability)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        let mut stmt_skill = tx.prepare(
            "INSERT INTO industryActivitySkills
             (blueprintTypeID, activityID, skillTypeID, level) VALUES (?1, ?2, ?3, ?4)",
        )?;

        for line in content.lines().filter(|l| !l.trim().is_empty()) {
            let obj: serde_json::Map<String, serde_json::Value> =
                serde_json::from_str(line).context("invalid blueprints line")?;

            let bp_id = key_as_i64(&obj)?;
            let max_runs = obj
                .get("maxProductionLimit")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            stmt_bp.execute(rusqlite::params![bp_id, max_runs])?;

            let Some(activities) = obj.get("activities").and_then(|v| v.as_object()) else {
                continue;
            };

            for (act_name, act_data) in activities {
                let activity_id: u8 = match act_name.as_str() {
                    "manufacturing"    => 1,
                    "research_time"    => 3,
                    "research_material"=> 4,
                    "copying"          => 5,
                    "invention"        => 8,
                    "reaction"         => 11,
                    _                  => continue,
                };
                let act_obj = match act_data.as_object() {
                    Some(o) => o,
                    None => continue,
                };

                let time = act_obj.get("time").and_then(|v| v.as_i64()).unwrap_or(0);
                stmt_act.execute(rusqlite::params![bp_id, activity_id, time])?;

                if let Some(mats) = act_obj.get("materials").and_then(|v| v.as_array()) {
                    for mat in mats {
                        let mat_type_id = mat.get("typeID").and_then(|v| v.as_i64()).unwrap_or(0);
                        let qty = mat.get("quantity").and_then(|v| v.as_i64()).unwrap_or(0);
                        stmt_mat.execute(rusqlite::params![bp_id, activity_id, mat_type_id, qty])?;
                    }
                }

                if let Some(prods) = act_obj.get("products").and_then(|v| v.as_array()) {
                    for prod in prods {
                        let prod_type_id =
                            prod.get("typeID").and_then(|v| v.as_i64()).unwrap_or(0);
                        let qty = prod.get("quantity").and_then(|v| v.as_i64()).unwrap_or(0);
                        let prob = prod.get("probability").and_then(|v| v.as_f64());
                        stmt_prod.execute(rusqlite::params![
                            bp_id, activity_id, prod_type_id, qty, prob
                        ])?;
                    }
                }

                if let Some(skills) = act_obj.get("skills").and_then(|v| v.as_array()) {
                    for skill in skills {
                        let skill_type_id =
                            skill.get("typeID").and_then(|v| v.as_i64()).unwrap_or(0);
                        let level = skill.get("level").and_then(|v| v.as_i64()).unwrap_or(0);
                        stmt_skill.execute(rusqlite::params![
                            bp_id, activity_id, skill_type_id, level
                        ])?;
                    }
                }
            }
        }
    }
    tx.commit()?;
    Ok(())
}

// ─── JSONL helpers ────────────────────────────────────────────────────────────

/// Extract the integer ID from the `_key` field (stored as a string by CCP).
fn key_as_i64(obj: &serde_json::Map<String, serde_json::Value>) -> Result<i64> {
    obj.get("_key")
        .and_then(|v| {
            v.as_str()
                .and_then(|s| s.parse::<i64>().ok())
                .or_else(|| v.as_i64())
        })
        .context("_key field missing or not an integer")
}

/// Extract the English name from a `name` field.
/// CCP stores names as either a plain string or a localized object
/// `{"en": "...", "de": "...", ...}`.
fn localized_name(obj: &serde_json::Map<String, serde_json::Value>) -> String {
    match obj.get("name") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Object(loc)) => loc
            .get("en")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        _ => String::new(),
    }
}

// ─── Public helpers ───────────────────────────────────────────────────────────

/// Returns the path to the installed SDE SQLite file, or `None` if it hasn't
/// been downloaded yet.
pub fn sde_db_path(app: &AppHandle) -> Option<PathBuf> {
    let path = app.path().app_data_dir().ok()?.join(SDE_DB_FILENAME);
    path.exists().then_some(path)
}

/// Serializable version info returned to the frontend.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SdeVersionInfo {
    pub build_number: u64,
    pub release_date: DateTime<Utc>,
    pub imported_at: DateTime<Utc>,
}

/// Read the cached version metadata from disk. Returns `None` if the SDE has
/// never been downloaded.
pub async fn read_version_meta(app: &AppHandle) -> Option<SdeVersionInfo> {
    let path = app.path().app_data_dir().ok()?.join(VERSION_META_FILENAME);
    let meta: SdeVersionMeta = serde_json::from_slice(&tokio::fs::read(path).await.ok()?).ok()?;
    Some(SdeVersionInfo {
        build_number: meta.build_number,
        release_date: meta.release_date,
        imported_at: meta.imported_at,
    })
}
