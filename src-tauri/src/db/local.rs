//! Local app state persisted in SQLite.
//!
//! Covers: virtual hangar stock, user settings, production plans,
//! ESI cache timestamps, per-type blueprint overrides, manual decisions,
//! and the production blacklist.
//!
//! Schema is created (and migrated) on `LocalDb::open`. All writes are
//! wrapped in transactions; reads use cached prepared statements.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use rand::Rng;

use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::types::{BuildTarget, Decision, StructureProfile, TypeId};

// ─── Error ────────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum LocalDbError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("Serialization error: {0}")]
    Json(#[from] serde_json::Error),
}

pub type LocalResult<T> = Result<T, LocalDbError>;

// ─── Domain types ─────────────────────────────────────────────────────────────

/// Analytics opt-in state — stored in the `settings` table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum AnalyticsConsent {
    /// First launch — the opt-in dialog has not been shown yet.
    Pending,
    Granted,
    Denied,
}

impl std::fmt::Display for AnalyticsConsent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pending => write!(f, "pending"),
            Self::Granted => write!(f, "granted"),
            Self::Denied => write!(f, "denied"),
        }
    }
}

impl std::str::FromStr for AnalyticsConsent {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, ()> {
        match s {
            "granted" => Ok(Self::Granted),
            "denied"  => Ok(Self::Denied),
            "pending" => Ok(Self::Pending),
            other => {
                eprintln!("[eve-nexus] unknown analytics_consent value {other:?}, defaulting to Pending");
                Ok(Self::Pending)
            }
        }
    }
}

/// Saved production plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductionPlan {
    pub id: String,
    pub name: String,
    pub targets: Vec<BuildTarget>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Per-plan overproduction multiplier. 1.5 = produce 50 % extra stock.
    /// When None, the global default (SETTING_DEFAULT_MULTIPLIER) applies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overproduction_multiplier: Option<f64>,
    /// Per-plan freight cost in ISK/m³ added to buy prices.
    /// When None, the global default (SETTING_DEFAULT_FREIGHT_ISK_PER_M3) applies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub freight_isk_per_m3: Option<f64>,
}

/// Lightweight plan listing (no full target list).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanSummary {
    pub id: String,
    pub name: String,
    pub target_count: usize,
    pub updated_at: DateTime<Utc>,
}

/// A character's blueprint, aggregated to one row per blueprint type.
/// `runs = -1` → BPO.  `me_level`/`te_level` are the best values the character owns.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterBlueprint {
    pub blueprint_type_id: crate::types::TypeId,
    /// -1 = BPO (unlimited); ≥ 0 = runs remaining on best BPC.
    pub runs: i32,
    pub me_level: u8,
    pub te_level: u8,
}

/// A user-configured market hub for price lookups.
///
/// When `structure_id` is `Some`, this hub uses the authenticated structure
/// market endpoint (`/markets/structures/{structure_id}/`).  In that case
/// `region_id` holds the structure ID as the cache key (EVE structure IDs are
/// in the billions and do not collide with region IDs in the low millions).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketRegion {
    pub id: String,
    pub label: String,
    /// For region hubs: the EVE region ID.
    /// For structure hubs: the structure ID (used as the market_prices cache key).
    pub region_id: i64,
    pub is_default: bool,
    /// Set when this hub sources prices from a player-owned structure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structure_id: Option<i64>,
}

/// Cached best prices for one item in one region.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPrice {
    pub region_id: i64,
    pub type_id: TypeId,
    /// Lowest active sell order — what you pay to buy immediately.
    pub best_sell: Option<f64>,
    /// Highest active buy order — what you get if you sell immediately.
    pub best_buy: Option<f64>,
    pub fetched_at: DateTime<Utc>,
}

/// A row from the `watched_systems` table.
#[derive(Debug, Clone)]
pub struct WatchedSystemRow {
    pub system_id:   i64,
    pub system_name: Option<String>,
    pub region_id:   Option<i64>,
}

// ─── Settings keys ────────────────────────────────────────────────────────────

pub const SETTING_ANALYTICS_CONSENT: &str = "analytics_consent";
pub const SETTING_WIZARD_COMPLETED: &str = "wizard_completed";
pub const SETTING_DEVICE_ID: &str = "device_id";
pub const SETTING_RESTOCK_MARGIN: &str = "restock_margin_threshold";
pub const SETTING_DEFAULT_MULTIPLIER: &str = "default_overproduction_multiplier";
pub const SETTING_DEFAULT_FREIGHT_ISK_PER_M3: &str = "default_freight_isk_per_m3";

// ─── LocalDb ─────────────────────────────────────────────────────────────────

pub struct LocalDb(Mutex<Connection>);

impl LocalDb {
    /// Open (or create) the local database at `path` and run schema migrations.
    ///
    /// Opens the database. If the file is malformed, renames it to
    /// `local.sqlite.corrupt.<timestamp>` and starts fresh so the app
    /// keeps working. The corrupt file is preserved for diagnosis.
    pub fn open(path: &Path) -> LocalResult<Self> {
        match Self::try_open(path) {
            Ok(db) => Ok(db),
            Err(first_err) => {
                eprintln!("[eve-nexus] local DB open failed ({first_err}) — backing up and recreating");
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let backup = path.with_file_name(format!("local.sqlite.corrupt.{ts}"));
                let _ = std::fs::rename(path, &backup);
                eprintln!("[eve-nexus] corrupt DB saved to {}", backup.display());
                Self::try_open(path)
            }
        }
    }

    fn try_open(path: &Path) -> LocalResult<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = DELETE;
             PRAGMA synchronous = FULL;
             PRAGMA foreign_keys = ON;",
        )?;
        // Catch corruption immediately rather than surfacing it mid-operation.
        let integrity: String = conn.query_row(
            "PRAGMA integrity_check(1);",
            [],
            |r| r.get(0),
        ).unwrap_or_else(|_| "error".into());
        if integrity != "ok" {
            return Err(LocalDbError::Sqlite(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CORRUPT),
                Some(format!("integrity_check failed: {integrity}")),
            )));
        }
        let db = Self(Mutex::new(conn));
        db.migrate()?;
        Ok(db)
    }

    fn conn(&self) -> LocalResult<std::sync::MutexGuard<'_, Connection>> {
        self.0.lock().map_err(|_| {
            LocalDbError::Sqlite(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
                Some("local db mutex poisoned".into()),
            ))
        })
    }

    fn migrate(&self) -> LocalResult<()> {
        // Add structure_id column to market_regions if it doesn't exist yet.
        // SQLite doesn't support IF NOT EXISTS on ALTER TABLE, so we ignore the error.
        let _ = self.conn()?.execute(
            "ALTER TABLE market_regions ADD COLUMN structure_id INTEGER",
            [],
        );
        let _ = self.conn()?.execute(
            "ALTER TABLE characters ADD COLUMN corp_assets_mode TEXT NOT NULL DEFAULT 'personal'",
            [],
        );
        let _ = self.conn()?.execute(
            "ALTER TABLE characters ADD COLUMN has_corp_access INTEGER NOT NULL DEFAULT 0",
            [],
        );

        self.conn()?.execute_batch(
            "
            BEGIN;
            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS virtual_hangar (
                type_id    INTEGER PRIMARY KEY,
                quantity   INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS structure_profiles (
                id         TEXT PRIMARY KEY,
                data       TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS blueprint_overrides (
                type_id  INTEGER PRIMARY KEY,
                me_level INTEGER NOT NULL DEFAULT 10,
                te_level INTEGER NOT NULL DEFAULT 20
            );

            CREATE TABLE IF NOT EXISTS manual_decisions (
                type_id  INTEGER PRIMARY KEY,
                decision TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS blacklist (
                type_id INTEGER PRIMARY KEY
            );

            CREATE TABLE IF NOT EXISTS esi_cache_timestamps (
                key        TEXT PRIMARY KEY,
                expires_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS production_plans (
                id           TEXT    PRIMARY KEY,
                name         TEXT    NOT NULL,
                target_count INTEGER NOT NULL DEFAULT 0,
                data         TEXT    NOT NULL,
                created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
                updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
            );

            -- ESI cached data --------------------------------------------------

            CREATE TABLE IF NOT EXISTS characters (
                character_id     INTEGER PRIMARY KEY,
                character_name   TEXT    NOT NULL,
                added_at         TEXT    NOT NULL DEFAULT (datetime('now')),
                corp_assets_mode TEXT    NOT NULL DEFAULT 'personal',
                has_corp_access  INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS esi_assets (
                character_id INTEGER NOT NULL,
                type_id      INTEGER NOT NULL,
                quantity     INTEGER NOT NULL,
                PRIMARY KEY (character_id, type_id)
            );

            CREATE TABLE IF NOT EXISTS esi_jobs (
                character_id INTEGER NOT NULL,
                job_id       INTEGER NOT NULL,
                data         TEXT    NOT NULL,
                PRIMARY KEY (character_id, job_id)
            );

            CREATE TABLE IF NOT EXISTS esi_skills (
                character_id INTEGER NOT NULL,
                skill_id     INTEGER NOT NULL,
                level        INTEGER NOT NULL,
                PRIMARY KEY (character_id, skill_id)
            );

            CREATE TABLE IF NOT EXISTS esi_blueprints (
                character_id      INTEGER NOT NULL,
                blueprint_type_id INTEGER NOT NULL,
                -- -1 = BPO (unlimited); ≥ 0 = runs remaining on best BPC
                runs              INTEGER NOT NULL DEFAULT -1,
                me_level          INTEGER NOT NULL DEFAULT 0,
                te_level          INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (character_id, blueprint_type_id)
            );

            CREATE TABLE IF NOT EXISTS esi_prices (
                type_id        INTEGER PRIMARY KEY,
                adjusted_price REAL    NOT NULL
            );

            CREATE TABLE IF NOT EXISTS esi_cost_indices (
                solar_system_id INTEGER PRIMARY KEY,
                manufacturing   REAL    NOT NULL DEFAULT 0,
                reaction        REAL    NOT NULL DEFAULT 0,
                invention       REAL    NOT NULL DEFAULT 0
            );

            -- Token fallback: used when the OS keychain is unavailable (e.g. WSL2).
            -- Permissions are enforced at the filesystem level by the app data dir.
            CREATE TABLE IF NOT EXISTS character_tokens (
                key        TEXT PRIMARY KEY,
                value      TEXT NOT NULL
            );

            -- Market hub configuration and cached order-book prices ---------------

            CREATE TABLE IF NOT EXISTS market_regions (
                id           TEXT    PRIMARY KEY,
                label        TEXT    NOT NULL,
                region_id    INTEGER NOT NULL UNIQUE,
                is_default   INTEGER NOT NULL DEFAULT 0,
                structure_id INTEGER
            );

            CREATE TABLE IF NOT EXISTS market_prices (
                region_id  INTEGER NOT NULL,
                type_id    INTEGER NOT NULL,
                best_sell  REAL,
                best_buy   REAL,
                fetched_at TEXT    NOT NULL,
                PRIMARY KEY (region_id, type_id)
            );

            -- Structure name cache: populated lazily as the user searches.
            -- market_structure_ids tracks which structures have a public market.
            CREATE TABLE IF NOT EXISTS structure_names (
                structure_id   INTEGER PRIMARY KEY,
                structure_name TEXT    NOT NULL
            );

            CREATE TABLE IF NOT EXISTS market_structure_ids (
                structure_id INTEGER PRIMARY KEY
            );

            -- Seed Jita as the default market hub.
            INSERT OR IGNORE INTO market_regions (id, label, region_id, is_default)
            VALUES ('jita-the-forge', 'Jita (The Forge)', 10000002, 1);

            -- Cache of solar system names resolved from ESI /universe/names/.
            CREATE TABLE IF NOT EXISTS system_names (
                system_id   INTEGER PRIMARY KEY,
                system_name TEXT    NOT NULL
            );

            -- Restock planner: items the user wants to keep on the market. --------
            CREATE TABLE IF NOT EXISTS restock_targets (
                type_id    INTEGER PRIMARY KEY,
                target_qty INTEGER NOT NULL DEFAULT 0
            );

            -- Player structures where the user has assets — used to suggest market hubs.
            CREATE TABLE IF NOT EXISTS asset_structure_locations (
                character_id INTEGER NOT NULL,
                structure_id INTEGER NOT NULL,
                PRIMARY KEY (character_id, structure_id)
            );

            -- Cached active market orders per character. ---------------------------
            CREATE TABLE IF NOT EXISTS esi_market_orders (
                character_id  INTEGER NOT NULL,
                order_id      INTEGER NOT NULL,
                type_id       INTEGER NOT NULL,
                volume_remain INTEGER NOT NULL,
                is_buy_order  INTEGER NOT NULL DEFAULT 0,
                price         REAL    NOT NULL DEFAULT 0,
                PRIMARY KEY (character_id, order_id)
            );

            -- Systems the user wants to compare cost indices and market prices for.
            CREATE TABLE IF NOT EXISTS watched_systems (
                system_id   INTEGER PRIMARY KEY,
                system_name TEXT,
                region_id   INTEGER
            );
            COMMIT;
            ",
        )?;

        // Additive column migrations — silently ignored if column already exists.
        {
            let conn = self.conn()?;
            let _ = conn.execute("ALTER TABLE watched_systems ADD COLUMN system_name TEXT",    []);
            let _ = conn.execute("ALTER TABLE watched_systems ADD COLUMN region_id   INTEGER", []);
        }

        Ok(())
    }
}

// ─── Token fallback storage ───────────────────────────────────────────────────

impl LocalDb {
    pub fn set_token(&self, key: &str, value: &str) -> LocalResult<()> {
        self.conn()?.execute(
            "INSERT OR REPLACE INTO character_tokens (key, value) VALUES (?1, ?2)",
            rusqlite::params![key, value],
        )?;
        Ok(())
    }

    pub fn get_token(&self, key: &str) -> LocalResult<Option<String>> {
        self.conn()?
            .query_row(
                "SELECT value FROM character_tokens WHERE key = ?1",
                [key],
                |r| r.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn delete_token(&self, key: &str) -> LocalResult<()> {
        self.conn()?.execute(
            "DELETE FROM character_tokens WHERE key = ?1",
            [key],
        )?;
        Ok(())
    }
}

// ─── Settings ─────────────────────────────────────────────────────────────────

impl LocalDb {
    pub fn get_setting(&self, key: &str) -> LocalResult<Option<String>> {
        self.conn()?
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                [key],
                |r| r.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> LocalResult<()> {
        self.conn()?.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, value],
        )?;
        Ok(())
    }

    pub fn get_analytics_consent(&self) -> LocalResult<AnalyticsConsent> {
        Ok(self
            .get_setting(SETTING_ANALYTICS_CONSENT)?
            .and_then(|v| v.parse().ok())
            .unwrap_or(AnalyticsConsent::Pending))
    }

    pub fn set_analytics_consent(&self, consent: AnalyticsConsent) -> LocalResult<()> {
        self.set_setting(SETTING_ANALYTICS_CONSENT, &consent.to_string())
    }

    /// Returns the stable anonymous device ID, generating and persisting one on first call.
    pub fn get_or_create_device_id(&self) -> LocalResult<String> {
        if let Some(id) = self.get_setting(SETTING_DEVICE_ID)? {
            return Ok(id);
        }
        let bytes: [u8; 16] = rand::thread_rng().gen();
        let id = format!(
            "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
            u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
            u16::from_be_bytes([bytes[4], bytes[5]]),
            u16::from_be_bytes([bytes[6], bytes[7]]) & 0x0FFF,
            (u16::from_be_bytes([bytes[8], bytes[9]]) & 0x3FFF) | 0x8000,
            u64::from_be_bytes([0, 0, bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]]),
        );
        self.set_setting(SETTING_DEVICE_ID, &id)?;
        Ok(id)
    }
}

// ─── Virtual hangar ───────────────────────────────────────────────────────────

impl LocalDb {
    pub fn get_virtual_hangar(&self) -> LocalResult<HashMap<TypeId, u64>> {
        let conn = self.conn()?;
        let mut stmt =
            conn.prepare_cached("SELECT type_id, quantity FROM virtual_hangar WHERE quantity > 0")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, TypeId>(0)?, r.get::<_, u64>(1)?)))?;
        rows.collect::<Result<HashMap<_, _>, _>>().map_err(Into::into)
    }

    /// Upsert a hangar quantity. Setting `quantity` to `0` removes the row.
    pub fn set_hangar_quantity(&self, type_id: TypeId, quantity: u64) -> LocalResult<()> {
        if quantity == 0 {
            self.conn()?.execute(
                "DELETE FROM virtual_hangar WHERE type_id = ?1",
                [type_id],
            )?;
        } else {
            self.conn()?.execute(
                "INSERT INTO virtual_hangar (type_id, quantity, updated_at)
                 VALUES (?1, ?2, datetime('now'))
                 ON CONFLICT(type_id) DO UPDATE
                 SET quantity = excluded.quantity,
                     updated_at = excluded.updated_at",
                rusqlite::params![type_id, quantity],
            )?;
        }
        Ok(())
    }

    /// Add `delta` units to an existing hangar entry (or create it).
    pub fn add_hangar_quantity(&self, type_id: TypeId, delta: u64) -> LocalResult<()> {
        self.conn()?.execute(
            "INSERT INTO virtual_hangar (type_id, quantity, updated_at)
             VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(type_id) DO UPDATE
             SET quantity   = quantity + excluded.quantity,
                 updated_at = excluded.updated_at",
            rusqlite::params![type_id, delta],
        )?;
        Ok(())
    }
}

// ─── Structure profiles ───────────────────────────────────────────────────────

impl LocalDb {
    pub fn get_structure_profiles(&self) -> LocalResult<HashMap<String, StructureProfile>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached("SELECT id, data FROM structure_profiles")?;
        let rows = stmt.query_map([], |r| {
            let id: String = r.get(0)?;
            let data: String = r.get(1)?;
            Ok((id, data))
        })?;
        let mut map = HashMap::new();
        for row in rows {
            let (id, data) = row?;
            let profile: StructureProfile = serde_json::from_str(&data)?;
            map.insert(id, profile);
        }
        Ok(map)
    }

    pub fn save_structure_profile(&self, profile: &StructureProfile) -> LocalResult<()> {
        let data = serde_json::to_string(profile)?;
        self.conn()?.execute(
            "INSERT INTO structure_profiles (id, data)
             VALUES (?1, ?2)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            rusqlite::params![profile.id, data],
        )?;
        Ok(())
    }

    pub fn delete_structure_profile(&self, id: &str) -> LocalResult<()> {
        self.conn()?.execute(
            "DELETE FROM structure_profiles WHERE id = ?1",
            [id],
        )?;
        Ok(())
    }
}

// ─── Blueprint overrides ──────────────────────────────────────────────────────

impl LocalDb {
    /// Returns `(me_levels, te_levels)` maps for all overridden types.
    pub fn get_blueprint_overrides(
        &self,
    ) -> LocalResult<(HashMap<TypeId, u8>, HashMap<TypeId, u8>)> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT type_id, me_level, te_level FROM blueprint_overrides",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, TypeId>(0)?,
                r.get::<_, u8>(1)?,
                r.get::<_, u8>(2)?,
            ))
        })?;
        let mut me_map = HashMap::new();
        let mut te_map = HashMap::new();
        for row in rows {
            let (type_id, me, te) = row?;
            me_map.insert(type_id, me);
            te_map.insert(type_id, te);
        }
        Ok((me_map, te_map))
    }

    pub fn set_blueprint_override(
        &self,
        type_id: TypeId,
        me_level: u8,
        te_level: u8,
    ) -> LocalResult<()> {
        self.conn()?.execute(
            "INSERT INTO blueprint_overrides (type_id, me_level, te_level)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(type_id) DO UPDATE
             SET me_level = excluded.me_level,
                 te_level = excluded.te_level",
            rusqlite::params![type_id, me_level, te_level],
        )?;
        Ok(())
    }

    pub fn clear_blueprint_override(&self, type_id: TypeId) -> LocalResult<()> {
        self.conn()?.execute(
            "DELETE FROM blueprint_overrides WHERE type_id = ?1",
            [type_id],
        )?;
        Ok(())
    }
}

// ─── Manual decisions ─────────────────────────────────────────────────────────

impl LocalDb {
    pub fn get_manual_decisions(&self) -> LocalResult<HashMap<TypeId, Decision>> {
        let conn = self.conn()?;
        let mut stmt =
            conn.prepare_cached("SELECT type_id, decision FROM manual_decisions")?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, TypeId>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut map = HashMap::new();
        for row in rows {
            let (type_id, decision_str) = row?;
            let decision: Decision = serde_json::from_str(&format!("\"{decision_str}\""))?;
            map.insert(type_id, decision);
        }
        Ok(map)
    }

    pub fn set_manual_decision(&self, type_id: TypeId, decision: Decision) -> LocalResult<()> {
        // Serialize just the variant name, e.g. "Build", "Buy", "UseHangar".
        let decision_str = format!("{:?}", decision);
        self.conn()?.execute(
            "INSERT INTO manual_decisions (type_id, decision)
             VALUES (?1, ?2)
             ON CONFLICT(type_id) DO UPDATE SET decision = excluded.decision",
            rusqlite::params![type_id, decision_str],
        )?;
        Ok(())
    }

    pub fn clear_manual_decision(&self, type_id: TypeId) -> LocalResult<()> {
        self.conn()?.execute(
            "DELETE FROM manual_decisions WHERE type_id = ?1",
            [type_id],
        )?;
        Ok(())
    }
}

// ─── Blacklist ────────────────────────────────────────────────────────────────

impl LocalDb {
    pub fn get_blacklist(&self) -> LocalResult<HashSet<TypeId>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached("SELECT type_id FROM blacklist")?;
        let rows = stmt.query_map([], |r| r.get::<_, TypeId>(0))?;
        rows.collect::<Result<HashSet<_>, _>>().map_err(Into::into)
    }

    pub fn add_to_blacklist(&self, type_id: TypeId) -> LocalResult<()> {
        self.conn()?.execute(
            "INSERT OR IGNORE INTO blacklist (type_id) VALUES (?1)",
            [type_id],
        )?;
        Ok(())
    }

    pub fn remove_from_blacklist(&self, type_id: TypeId) -> LocalResult<()> {
        self.conn()?.execute(
            "DELETE FROM blacklist WHERE type_id = ?1",
            [type_id],
        )?;
        Ok(())
    }
}

// ─── ESI cache timestamps ─────────────────────────────────────────────────────

impl LocalDb {
    /// Return the cached expiry time for an ESI endpoint key.
    /// Returns `None` if not cached or already expired.
    pub fn get_cache_expiry(&self, key: &str) -> LocalResult<Option<DateTime<Utc>>> {
        let raw: Option<String> = self
            .conn()?
            .query_row(
                "SELECT expires_at FROM esi_cache_timestamps WHERE key = ?1",
                [key],
                |r| r.get(0),
            )
            .optional()?;

        Ok(raw.and_then(|s| s.parse::<DateTime<Utc>>().ok()).filter(|&t| t > Utc::now()))
    }

    pub fn set_cache_expiry(&self, key: &str, expires_at: DateTime<Utc>) -> LocalResult<()> {
        self.conn()?.execute(
            "INSERT INTO esi_cache_timestamps (key, expires_at)
             VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at",
            rusqlite::params![key, expires_at.to_rfc3339()],
        )?;
        Ok(())
    }

    /// Delete a cache entry so the next fetch is forced to hit ESI.
    pub fn delete_cache_expiry(&self, key: &str) -> LocalResult<()> {
        self.conn()?.execute(
            "DELETE FROM esi_cache_timestamps WHERE key = ?1",
            [key],
        )?;
        Ok(())
    }

    /// Delete all cache entries whose key starts with `prefix`.
    pub fn delete_cache_expiry_prefix(&self, prefix: &str) -> LocalResult<()> {
        self.conn()?.execute(
            "DELETE FROM esi_cache_timestamps WHERE key LIKE ?1",
            [format!("{prefix}%")],
        )?;
        Ok(())
    }
}

// ─── Production plans ─────────────────────────────────────────────────────────

impl LocalDb {
    pub fn list_plans(&self) -> LocalResult<Vec<PlanSummary>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT id, name, target_count, updated_at
             FROM production_plans
             ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, usize>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?;
        let mut plans = Vec::new();
        for row in rows {
            let (id, name, target_count, updated_at_str) = row?;
            let updated_at = updated_at_str
                .parse::<DateTime<Utc>>()
                .unwrap_or_else(|_| Utc::now());
            plans.push(PlanSummary { id, name, target_count, updated_at });
        }
        Ok(plans)
    }

    pub fn get_plan(&self, id: &str) -> LocalResult<Option<ProductionPlan>> {
        let raw: Option<String> = self
            .conn()?
            .query_row(
                "SELECT data FROM production_plans WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;

        match raw {
            None => Ok(None),
            Some(data) => Ok(Some(serde_json::from_str(&data)?)),
        }
    }

    pub fn save_plan(&self, plan: &ProductionPlan) -> LocalResult<()> {
        let data = serde_json::to_string(plan)?;
        self.conn()?.execute(
            "INSERT INTO production_plans (id, name, target_count, data, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE
             SET name         = excluded.name,
                 target_count = excluded.target_count,
                 data         = excluded.data,
                 updated_at   = excluded.updated_at",
            rusqlite::params![
                plan.id,
                plan.name,
                plan.targets.len(),
                data,
                plan.created_at.to_rfc3339(),
                plan.updated_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn delete_plan(&self, id: &str) -> LocalResult<()> {
        self.conn()?.execute(
            "DELETE FROM production_plans WHERE id = ?1",
            [id],
        )?;
        Ok(())
    }
}

// ─── Characters ──────────────────────────────────────────────────────────────

impl LocalDb {
    pub fn get_characters(&self) -> LocalResult<Vec<(crate::types::CharacterId, String)>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT character_id, character_name FROM characters ORDER BY added_at",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, crate::types::CharacterId>(0)?, r.get::<_, String>(1)?))
        })?;
        rows.collect::<Result<_, _>>().map_err(Into::into)
    }

    pub fn get_character_extra(&self, character_id: crate::types::CharacterId) -> LocalResult<(String, bool)> {
        let conn = self.conn()?;
        let row: Option<(String, i32)> = conn.query_row(
            "SELECT corp_assets_mode, has_corp_access FROM characters WHERE character_id = ?1",
            [character_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?;
        Ok(row.map(|(m, a)| (m, a != 0)).unwrap_or_else(|| ("personal".to_string(), false)))
    }

    pub fn set_corp_assets_mode(&self, character_id: crate::types::CharacterId, mode: &str) -> LocalResult<()> {
        self.conn()?.execute(
            "UPDATE characters SET corp_assets_mode = ?1 WHERE character_id = ?2",
            rusqlite::params![mode, character_id],
        )?;
        Ok(())
    }

    pub fn set_corp_access(&self, character_id: crate::types::CharacterId, has_access: bool) -> LocalResult<()> {
        self.conn()?.execute(
            "UPDATE characters SET has_corp_access = ?1 WHERE character_id = ?2",
            rusqlite::params![has_access as i32, character_id],
        )?;
        Ok(())
    }

    pub fn upsert_character(
        &self,
        character_id: crate::types::CharacterId,
        name: &str,
    ) -> LocalResult<()> {
        self.conn()?.execute(
            "INSERT INTO characters (character_id, character_name)
             VALUES (?1, ?2)
             ON CONFLICT(character_id) DO UPDATE SET character_name = excluded.character_name",
            rusqlite::params![character_id, name],
        )?;
        Ok(())
    }

    pub fn remove_character(&self, character_id: crate::types::CharacterId) -> LocalResult<()> {
        self.conn()?.execute(
            "DELETE FROM characters WHERE character_id = ?1",
            [character_id],
        )?;
        Ok(())
    }
}

// ─── ESI cached data ──────────────────────────────────────────────────────────

impl LocalDb {
    // ── Assets ───────────────────────────────────────────────────────────────

    pub fn get_assets(
        &self,
        character_id: crate::types::CharacterId,
    ) -> LocalResult<HashMap<crate::types::TypeId, u64>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT type_id, quantity FROM esi_assets WHERE character_id = ?1",
        )?;
        let rows = stmt.query_map([character_id], |r| {
            Ok((r.get::<_, crate::types::TypeId>(0)?, r.get::<_, u64>(1)?))
        })?;
        rows.collect::<Result<HashMap<_, _>, _>>().map_err(Into::into)
    }

    pub fn replace_assets(
        &self,
        character_id: crate::types::CharacterId,
        assets: &HashMap<crate::types::TypeId, u64>,
    ) -> LocalResult<()> {
        let conn = self.conn()?;
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM esi_assets WHERE character_id = ?1", [character_id])?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO esi_assets (character_id, type_id, quantity) VALUES (?1, ?2, ?3)",
            )?;
            for (&type_id, &qty) in assets {
                stmt.execute(rusqlite::params![character_id, type_id, qty])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Merge additional asset quantities into existing assets (used for corp assets).
    pub fn merge_assets(
        &self,
        character_id: crate::types::CharacterId,
        assets: &HashMap<crate::types::TypeId, u64>,
    ) -> LocalResult<()> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "INSERT INTO esi_assets (character_id, type_id, quantity) VALUES (?1, ?2, ?3)
             ON CONFLICT(character_id, type_id) DO UPDATE SET quantity = quantity + excluded.quantity",
        )?;
        for (&type_id, &qty) in assets {
            stmt.execute(rusqlite::params![character_id, type_id, qty])?;
        }
        Ok(())
    }

    // ── Jobs ─────────────────────────────────────────────────────────────────

    pub fn get_jobs(
        &self,
        character_id: crate::types::CharacterId,
    ) -> LocalResult<Vec<crate::types::EsiJob>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT data FROM esi_jobs WHERE character_id = ?1",
        )?;
        let rows = stmt.query_map([character_id], |r| r.get::<_, String>(0))?;
        let mut jobs = Vec::new();
        for row in rows {
            let data = row?;
            jobs.push(serde_json::from_str::<crate::types::EsiJob>(&data)?);
        }
        Ok(jobs)
    }

    pub fn replace_jobs(
        &self,
        character_id: crate::types::CharacterId,
        jobs: &[crate::types::EsiJob],
    ) -> LocalResult<()> {
        let conn = self.conn()?;
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM esi_jobs WHERE character_id = ?1", [character_id])?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO esi_jobs (character_id, job_id, data) VALUES (?1, ?2, ?3)",
            )?;
            for job in jobs {
                let data = serde_json::to_string(job)?;
                stmt.execute(rusqlite::params![character_id, job.job_id, data])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    // ── Skills ────────────────────────────────────────────────────────────────

    pub fn get_skills(
        &self,
        character_id: crate::types::CharacterId,
    ) -> LocalResult<HashMap<crate::types::TypeId, u8>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT skill_id, level FROM esi_skills WHERE character_id = ?1",
        )?;
        let rows = stmt.query_map([character_id], |r| {
            Ok((r.get::<_, crate::types::TypeId>(0)?, r.get::<_, u8>(1)?))
        })?;
        rows.collect::<Result<HashMap<_, _>, _>>().map_err(Into::into)
    }

    pub fn replace_skills(
        &self,
        character_id: crate::types::CharacterId,
        skills: &HashMap<crate::types::TypeId, u8>,
    ) -> LocalResult<()> {
        let conn = self.conn()?;
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM esi_skills WHERE character_id = ?1", [character_id])?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO esi_skills (character_id, skill_id, level) VALUES (?1, ?2, ?3)",
            )?;
            for (&skill_id, &level) in skills {
                stmt.execute(rusqlite::params![character_id, skill_id, level])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    // ── Adjusted prices ───────────────────────────────────────────────────────

    pub fn get_adjusted_prices(
        &self,
    ) -> LocalResult<HashMap<crate::types::TypeId, f64>> {
        let conn = self.conn()?;
        let mut stmt =
            conn.prepare_cached("SELECT type_id, adjusted_price FROM esi_prices")?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, crate::types::TypeId>(0)?, r.get::<_, f64>(1)?))
        })?;
        rows.collect::<Result<HashMap<_, _>, _>>().map_err(Into::into)
    }

    pub fn replace_adjusted_prices(
        &self,
        prices: &HashMap<crate::types::TypeId, f64>,
    ) -> LocalResult<()> {
        let conn = self.conn()?;
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch("DELETE FROM esi_prices")?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO esi_prices (type_id, adjusted_price) VALUES (?1, ?2)",
            )?;
            for (&type_id, &price) in prices {
                stmt.execute(rusqlite::params![type_id, price])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    // ── Cost indices ──────────────────────────────────────────────────────────

    pub fn get_cost_indices(
        &self,
    ) -> LocalResult<HashMap<crate::types::SolarSystemId, crate::types::CostIndex>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT solar_system_id, manufacturing, reaction, invention
             FROM esi_cost_indices",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(crate::types::CostIndex {
                solar_system_id: r.get(0)?,
                manufacturing: r.get(1)?,
                reaction: r.get(2)?,
                invention: r.get(3)?,
            })
        })?;
        let mut map = HashMap::new();
        for row in rows {
            let ci = row?;
            map.insert(ci.solar_system_id, ci);
        }
        Ok(map)
    }

    pub fn replace_cost_indices(
        &self,
        indices: &HashMap<crate::types::SolarSystemId, crate::types::CostIndex>,
    ) -> LocalResult<()> {
        let conn = self.conn()?;
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch("DELETE FROM esi_cost_indices")?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO esi_cost_indices
                 (solar_system_id, manufacturing, reaction, invention)
                 VALUES (?1, ?2, ?3, ?4)",
            )?;
            for ci in indices.values() {
                stmt.execute(rusqlite::params![
                    ci.solar_system_id,
                    ci.manufacturing,
                    ci.reaction,
                    ci.invention,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    // ── Blueprints ────────────────────────────────────────────────────────────

    pub fn get_blueprints(
        &self,
        character_id: crate::types::CharacterId,
    ) -> LocalResult<Vec<CharacterBlueprint>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT blueprint_type_id, runs, me_level, te_level
             FROM esi_blueprints WHERE character_id = ?1",
        )?;
        let rows = stmt.query_map([character_id], |r| {
            Ok(CharacterBlueprint {
                blueprint_type_id: r.get(0)?,
                runs: r.get(1)?,
                me_level: r.get(2)?,
                te_level: r.get(3)?,
            })
        })?;
        rows.collect::<Result<_, _>>().map_err(Into::into)
    }

    /// Return all blueprints across all characters as `(character_id, blueprint)` pairs.
    pub fn get_all_blueprints(
        &self,
    ) -> LocalResult<Vec<(crate::types::CharacterId, CharacterBlueprint)>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT character_id, blueprint_type_id, runs, me_level, te_level
             FROM esi_blueprints",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, crate::types::CharacterId>(0)?,
                CharacterBlueprint {
                    blueprint_type_id: r.get(1)?,
                    runs: r.get(2)?,
                    me_level: r.get(3)?,
                    te_level: r.get(4)?,
                },
            ))
        })?;
        rows.collect::<Result<_, _>>().map_err(Into::into)
    }

    /// Replace all cached blueprints for a character.
    /// Each entry is de-duplicated by blueprint_type_id; the BPO wins over BPC,
    /// and among multiple BPCs the best ME/TE are kept.
    pub fn replace_blueprints(
        &self,
        character_id: crate::types::CharacterId,
        blueprints: &[CharacterBlueprint],
    ) -> LocalResult<()> {
        let conn = self.conn()?;
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM esi_blueprints WHERE character_id = ?1",
            [character_id],
        )?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO esi_blueprints
                 (character_id, blueprint_type_id, runs, me_level, te_level)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(character_id, blueprint_type_id) DO UPDATE
                 SET runs     = CASE WHEN excluded.runs = -1 THEN -1 ELSE MAX(runs, excluded.runs) END,
                     me_level = MAX(me_level, excluded.me_level),
                     te_level = MAX(te_level, excluded.te_level)",
            )?;
            for bp in blueprints {
                stmt.execute(rusqlite::params![
                    character_id,
                    bp.blueprint_type_id,
                    bp.runs,
                    bp.me_level,
                    bp.te_level,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }
}

// ─── Managed state + path helper ──────────────────────────────────────────────

/// Tauri managed state for the local database.
// ─── Market regions ───────────────────────────────────────────────────────────

impl LocalDb {
    pub fn get_market_regions(&self) -> LocalResult<Vec<MarketRegion>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, label, region_id, is_default, structure_id
             FROM market_regions ORDER BY is_default DESC, label ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(MarketRegion {
                id:           row.get(0)?,
                label:        row.get(1)?,
                region_id:    row.get(2)?,
                is_default:   row.get::<_, i32>(3)? != 0,
                structure_id: row.get(4)?,
            })
        })?;
        rows.collect::<Result<_, _>>().map_err(Into::into)
    }

    pub fn save_market_region(&self, region: &MarketRegion) -> LocalResult<()> {
        self.conn()?.execute(
            "INSERT OR REPLACE INTO market_regions (id, label, region_id, is_default, structure_id)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                region.id,
                region.label,
                region.region_id,
                region.is_default as i32,
                region.structure_id,
            ],
        )?;
        Ok(())
    }

    pub fn delete_market_region(&self, id: &str) -> LocalResult<()> {
        self.conn()?.execute(
            "DELETE FROM market_regions WHERE id = ?1",
            [id],
        )?;
        // Clean up cached prices for this region (look up region_id first).
        Ok(())
    }
}

// ─── Market prices ────────────────────────────────────────────────────────────

impl LocalDb {
    /// Return cached prices for the given type_ids in a region.
    pub fn get_market_prices(
        &self,
        region_id: i64,
        type_ids: &[TypeId],
    ) -> LocalResult<Vec<MarketPrice>> {
        if type_ids.is_empty() {
            return Ok(vec![]);
        }
        let conn = self.conn()?;
        let placeholders = type_ids
            .iter()
            .enumerate()
            .map(|(i, _)| format!("?{}", i + 2))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT region_id, type_id, best_sell, best_buy, fetched_at
             FROM market_prices
             WHERE region_id = ?1 AND type_id IN ({placeholders})"
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(region_id)];
        for &id in type_ids {
            params.push(Box::new(id));
        }
        let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(param_refs.as_slice(), |row| {
            let fetched_str: String = row.get(4)?;
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, TypeId>(1)?,
                row.get::<_, Option<f64>>(2)?,
                row.get::<_, Option<f64>>(3)?,
                fetched_str,
            ))
        })?;
        let mut result = Vec::new();
        for row in rows {
            let (rid, tid, sell, buy, fetched_str) = row?;
            let fetched_at = fetched_str
                .parse::<DateTime<Utc>>()
                .unwrap_or_else(|_| Utc::now());
            result.push(MarketPrice {
                region_id: rid,
                type_id: tid,
                best_sell: sell,
                best_buy: buy,
                fetched_at,
            });
        }
        Ok(result)
    }

    /// Upsert a single price record.
    pub fn replace_market_price(&self, price: &MarketPrice) -> LocalResult<()> {
        self.conn()?.execute(
            "INSERT OR REPLACE INTO market_prices (region_id, type_id, best_sell, best_buy, fetched_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                price.region_id,
                price.type_id,
                price.best_sell,
                price.best_buy,
                price.fetched_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    /// Return which type_ids have no cached price or a price older than `max_age_secs`.
    pub fn get_stale_market_types(
        &self,
        region_id: i64,
        type_ids: &[TypeId],
        max_age_secs: i64,
    ) -> LocalResult<Vec<TypeId>> {
        if type_ids.is_empty() {
            return Ok(vec![]);
        }
        let fresh = self.get_market_prices(region_id, type_ids)?;
        let cutoff = Utc::now() - chrono::Duration::seconds(max_age_secs);
        let fresh_ids: std::collections::HashSet<TypeId> = fresh
            .iter()
            .filter(|p| p.fetched_at > cutoff)
            .map(|p| p.type_id)
            .collect();
        Ok(type_ids.iter().filter(|&&id| !fresh_ids.contains(&id)).copied().collect())
    }

    /// Delete all cached prices for a region.
    pub fn delete_market_prices_for_region(&self, region_id: i64) -> LocalResult<()> {
        self.conn()?.execute(
            "DELETE FROM market_prices WHERE region_id = ?1",
            [region_id],
        )?;
        Ok(())
    }
}

// ─── System name cache ────────────────────────────────────────────────────────

impl LocalDb {
    pub fn get_system_name(&self, system_id: crate::types::SolarSystemId) -> LocalResult<Option<String>> {
        self.conn()?
            .query_row(
                "SELECT system_name FROM system_names WHERE system_id = ?1",
                [system_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(LocalDbError::Sqlite)
    }

    /// Case-insensitive prefix search against the local name cache.
    /// Returns up to `limit` `(system_id, system_name)` pairs sorted by name.
    pub fn search_system_names_prefix(
        &self,
        prefix: &str,
        limit: usize,
    ) -> LocalResult<Vec<(crate::types::SolarSystemId, String)>> {
        let conn = self.conn()?;
        let pattern = format!("{prefix}%");
        let mut stmt = conn.prepare_cached(
            "SELECT system_id, system_name FROM system_names
             WHERE system_name LIKE ?1 ESCAPE '\\'
             ORDER BY system_name
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![pattern, limit as i64],
            |r| Ok((r.get::<_, crate::types::SolarSystemId>(0)?, r.get::<_, String>(1)?)),
        )?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn upsert_system_names(
        &self,
        names: &[(crate::types::SolarSystemId, &str)],
    ) -> LocalResult<()> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(
            "INSERT OR REPLACE INTO system_names (system_id, system_name) VALUES (?1, ?2)",
        )?;
        for (id, name) in names {
            stmt.execute(rusqlite::params![id, name])?;
        }
        Ok(())
    }
}

// ─── Structure name cache ─────────────────────────────────────────────────────

impl LocalDb {
    /// Store the full list of public market structure IDs (replaces any prior list).
    pub fn replace_market_structure_ids(&self, ids: &[i64]) -> LocalResult<()> {
        let conn = self.conn()?;
        conn.execute("DELETE FROM market_structure_ids", [])?;
        let mut stmt = conn.prepare_cached(
            "INSERT OR IGNORE INTO market_structure_ids (structure_id) VALUES (?1)",
        )?;
        for &id in ids {
            stmt.execute([id])?;
        }
        Ok(())
    }

    /// Return structure IDs that are in the market list but have no cached name,
    /// up to `limit` rows.
    pub fn get_uncached_market_structure_ids(&self, limit: usize) -> LocalResult<Vec<i64>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT msi.structure_id
             FROM market_structure_ids msi
             LEFT JOIN structure_names sn ON sn.structure_id = msi.structure_id
             WHERE sn.structure_id IS NULL
             LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit as i64], |r| r.get(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Upsert structure names into the local cache.
    pub fn upsert_structure_names(&self, names: &[(i64, &str)]) -> LocalResult<()> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(
            "INSERT OR REPLACE INTO structure_names (structure_id, structure_name) VALUES (?1, ?2)",
        )?;
        for (id, name) in names {
            stmt.execute(rusqlite::params![id, name])?;
        }
        Ok(())
    }

    /// Case-insensitive prefix search — used for numeric ID lookups.
    pub fn search_structure_names_prefix(
        &self,
        prefix: &str,
        limit: usize,
    ) -> LocalResult<Vec<(i64, String)>> {
        let conn = self.conn()?;
        let pattern = format!("{prefix}%");
        let mut stmt = conn.prepare_cached(
            "SELECT structure_id, structure_name FROM structure_names
             WHERE CAST(structure_id AS TEXT) LIKE ?1 ESCAPE '\\'
             ORDER BY structure_name
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![pattern, limit as i64],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
        )?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Case-insensitive contains search over ALL cached structure names.
    /// Unlike `search_structure_names_contains`, this is not limited to the
    /// public market list — private structures (cached from ESI search or asset
    /// lookups) are included.
    pub fn search_all_structure_names_contains(
        &self,
        query: &str,
        limit: usize,
    ) -> LocalResult<Vec<(i64, String)>> {
        let conn = self.conn()?;
        let pattern = format!("%{query}%");
        let mut stmt = conn.prepare_cached(
            "SELECT structure_id, structure_name FROM structure_names
             WHERE structure_name LIKE ?1 ESCAPE '\\'
             ORDER BY structure_name
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![pattern, limit as i64],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
        )?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Case-insensitive contains search over cached structure names that are in
    /// the market structure list.  Returns up to `limit` `(id, name)` pairs.
    pub fn search_structure_names_contains(
        &self,
        query: &str,
        limit: usize,
    ) -> LocalResult<Vec<(i64, String)>> {
        let conn = self.conn()?;
        let pattern = format!("%{query}%");
        let mut stmt = conn.prepare_cached(
            "SELECT sn.structure_id, sn.structure_name
             FROM structure_names sn
             JOIN market_structure_ids msi ON msi.structure_id = sn.structure_id
             WHERE sn.structure_name LIKE ?1 ESCAPE '\\'
             ORDER BY sn.structure_name
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![pattern, limit as i64],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
        )?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Store the set of player-structure IDs where a character has assets.
    /// Replaces the prior list for that character.
    pub fn replace_asset_structure_locations(
        &self,
        character_id: crate::types::CharacterId,
        ids: &[i64],
    ) -> LocalResult<()> {
        let conn = self.conn()?;
        conn.execute(
            "DELETE FROM asset_structure_locations WHERE character_id = ?1",
            [character_id],
        )?;
        let mut stmt = conn.prepare_cached(
            "INSERT OR IGNORE INTO asset_structure_locations (character_id, structure_id) VALUES (?1, ?2)",
        )?;
        for &id in ids {
            stmt.execute(rusqlite::params![character_id, id])?;
        }
        Ok(())
    }

    /// Merge additional player-structure IDs for a character without clearing existing ones.
    /// Used to add corporation-hangar structures alongside personal-hangar ones.
    pub fn merge_asset_structure_locations(
        &self,
        character_id: crate::types::CharacterId,
        ids: &[i64],
    ) -> LocalResult<()> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(
            "INSERT OR IGNORE INTO asset_structure_locations (character_id, structure_id) VALUES (?1, ?2)",
        )?;
        for &id in ids {
            stmt.execute(rusqlite::params![character_id, id])?;
        }
        Ok(())
    }

    /// Return (character_id, structure_id) pairs for all asset structure locations.
    /// One row per (character, structure) pair — use the character_id for ESI auth.
    pub fn get_asset_structure_ids(&self) -> LocalResult<Vec<(crate::types::CharacterId, i64)>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT character_id, structure_id FROM asset_structure_locations ORDER BY structure_id",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, crate::types::CharacterId>(0)?, r.get::<_, i64>(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }
}

// ─── System cost ──────────────────────────────────────────────────────────────

impl LocalDb {
    /// Return the top `limit` systems for `activity` ("manufacturing" | "reaction")
    /// ordered by ascending cost index.  Only returns rows where `system_names`
    /// has a cached name — caller should ensure names are populated first.
    pub fn get_cheapest_systems(
        &self,
        activity: &str,
        limit: usize,
    ) -> LocalResult<Vec<(crate::types::SolarSystemId, String, f64)>> {
        let col = match activity {
            "reaction" => "reaction",
            _          => "manufacturing",
        };
        // Inline the column name — it's never user-supplied; only our two safe strings.
        let sql = format!(
            "SELECT c.solar_system_id, sn.system_name, c.{col}
             FROM esi_cost_indices c
             JOIN system_names sn ON sn.system_id = c.solar_system_id
             WHERE c.{col} > 0
             ORDER BY c.{col} ASC
             LIMIT ?1"
        );
        let conn = self.conn()?;
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([limit as i64], |r| {
            Ok((r.get::<_, i32>(0)?, r.get::<_, String>(1)?, r.get::<_, f64>(2)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}

// ─── Restock targets ──────────────────────────────────────────────────────────

impl LocalDb {
    pub fn get_restock_targets(&self) -> LocalResult<Vec<(TypeId, u64)>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached("SELECT type_id, target_qty FROM restock_targets ORDER BY type_id")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, TypeId>(0)?, r.get::<_, u64>(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn upsert_restock_target(&self, type_id: TypeId, target_qty: u64) -> LocalResult<()> {
        self.conn()?.execute(
            "INSERT INTO restock_targets (type_id, target_qty)
             VALUES (?1, ?2)
             ON CONFLICT(type_id) DO UPDATE SET target_qty = excluded.target_qty",
            rusqlite::params![type_id, target_qty],
        )?;
        Ok(())
    }

    pub fn delete_restock_target(&self, type_id: TypeId) -> LocalResult<()> {
        self.conn()?.execute(
            "DELETE FROM restock_targets WHERE type_id = ?1",
            [type_id],
        )?;
        Ok(())
    }

    // ── Watched systems (cost-index + market hub comparison) ──────────────────

    pub fn get_watched_systems(&self) -> LocalResult<Vec<WatchedSystemRow>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT system_id, system_name, region_id FROM watched_systems ORDER BY system_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(WatchedSystemRow {
                system_id:   r.get(0)?,
                system_name: r.get(1)?,
                region_id:   r.get(2)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn add_watched_system(
        &self,
        system_id: i64,
        system_name: &str,
        region_id: Option<i64>,
    ) -> LocalResult<()> {
        self.conn()?.execute(
            "INSERT OR REPLACE INTO watched_systems (system_id, system_name, region_id)
             VALUES (?1, ?2, ?3)",
            rusqlite::params![system_id, system_name, region_id],
        )?;
        Ok(())
    }

    pub fn remove_watched_system(&self, system_id: i64) -> LocalResult<()> {
        let conn = self.conn()?;
        conn.execute("DELETE FROM watched_systems WHERE system_id = ?1", [system_id])?;
        // Remove the auto-registered market region entry, if any.
        let auto_id = format!("ws:{system_id}");
        conn.execute("DELETE FROM market_regions WHERE id = ?1", [auto_id.as_str()])?;
        Ok(())
    }

    /// Insert a market region entry only if no entry already exists with that
    /// region_id (uses INSERT OR IGNORE so hand-configured hubs are not overwritten).
    pub fn try_add_market_hub(&self, id: &str, label: &str, region_id: i64) -> LocalResult<()> {
        self.conn()?.execute(
            "INSERT OR IGNORE INTO market_regions (id, label, region_id, is_default)
             VALUES (?1, ?2, ?3, 0)",
            rusqlite::params![id, label, region_id],
        )?;
        Ok(())
    }

    /// Sum of `volume_remain` for active sell orders per type across all characters.
    pub fn get_sell_quantities(&self) -> LocalResult<HashMap<TypeId, u64>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT type_id, SUM(volume_remain)
             FROM esi_market_orders
             WHERE is_buy_order = 0
             GROUP BY type_id",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, TypeId>(0)?, r.get::<_, u64>(1)?)))?;
        rows.collect::<Result<HashMap<_, _>, _>>().map_err(Into::into)
    }

    pub fn replace_market_orders(
        &self,
        character_id: crate::types::CharacterId,
        orders: &[MarketOrderRow],
    ) -> LocalResult<()> {
        let conn = self.conn()?;
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM esi_market_orders WHERE character_id = ?1", [character_id])?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO esi_market_orders
                 (character_id, order_id, type_id, volume_remain, is_buy_order, price)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for o in orders {
                stmt.execute(rusqlite::params![
                    character_id,
                    o.order_id,
                    o.type_id,
                    o.volume_remain,
                    o.is_buy_order as i32,
                    o.price,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }
}

// ─── Market order row (used for DB storage) ───────────────────────────────────

#[derive(Debug, Clone)]
pub struct MarketOrderRow {
    pub order_id:     i64,
    pub type_id:      TypeId,
    pub volume_remain: u64,
    pub is_buy_order: bool,
    pub price:        f64,
}

/// Holds an `Arc` so the same connection can be shared with `AuthManager`.
pub struct LocalState(pub std::sync::Arc<LocalDb>);

impl LocalState {
    pub fn new(db: std::sync::Arc<LocalDb>) -> Self {
        Self(db)
    }
}

/// Returns the path to the local database file in the app data directory.
pub fn local_db_path(data_dir: &Path) -> PathBuf {
    data_dir.join("local.sqlite")
}
