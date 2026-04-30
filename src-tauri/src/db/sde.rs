//! Read-only queries against the CCP SDE SQLite database.
//!
//! `SdeDb` wraps the connection and is registered as Tauri managed state.
//! All methods are synchronous — lock contention is negligible for reads.
//!
//! Column names match the CCP JSONL export (camelCase, e.g. `typeID`,
//! `blueprintTypeID`). Values were stored as TEXT by the importer; SQLite's
//! type coercion handles the casts transparently.
//!
//! Never write to the SDE file.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OpenFlags, OptionalExtension, Row};
use thiserror::Error;

use crate::types::{ActivityId, TypeId};

// ─── Error ────────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum SdeError {
    #[error("SDE database is not available — update may still be in progress")]
    NotAvailable,
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

pub type SdeResult<T> = Result<T, SdeError>;

// ─── Raw SDE row types ────────────────────────────────────────────────────────
// These are thin query results. The solver and commands layer convert them
// into the richer domain types from types/mod.rs.

/// Basic type metadata from `invTypes` + joined `invGroups`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SdeTypeInfo {
    pub type_id: TypeId,
    pub type_name: String,
    pub group_id: i32,
    pub category_id: i32,
    /// m³ per unit.
    pub volume: f64,
    pub published: bool,
}

/// One material row from `industryActivityMaterials`.
#[derive(Debug, Clone)]
pub struct SdeMaterial {
    pub material_type_id: TypeId,
    /// Quantity required per single run (before ME reduction).
    pub quantity: u64,
}

/// One product row from `industryActivityProducts`.
#[derive(Debug, Clone)]
pub struct SdeProduct {
    pub product_type_id: TypeId,
    pub quantity: u64,
    /// `Some` for invention (< 1.0); `None` / `1.0` for manufacturing.
    pub probability: Option<f64>,
}

/// One skill row from `industryActivitySkills`.
#[derive(Debug, Clone)]
pub struct SdeSkillReq {
    pub skill_type_id: TypeId,
    pub level: u8,
}

/// Blueprint-level metadata from `industryBlueprints`.
#[derive(Debug, Clone)]
pub struct SdeBlueprintInfo {
    pub blueprint_type_id: TypeId,
    /// Maximum number of runs per BPC (0 = BPO / unlimited).
    pub max_production_limit: u32,
}

/// Activity time row from `industryActivities`.
#[derive(Debug, Clone)]
pub struct SdeActivityTime {
    pub blueprint_type_id: TypeId,
    pub activity_id: u8,
    /// Base job duration in seconds (before TE reduction).
    pub time_seconds: u32,
}

/// One row from the blueprint browser query — links a blueprint to its product.
#[derive(Debug, Clone)]
pub struct SdeBlueprintEntry {
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
}

/// A distinct product category that has at least one blueprint.
#[derive(Debug, Clone)]
pub struct SdeCategory {
    pub category_id: i32,
    pub category_name: String,
    pub blueprint_count: u32,
}

/// A product group within a category that has at least one blueprint.
#[derive(Debug, Clone)]
pub struct SdeGroup {
    pub group_id: i32,
    pub group_name: String,
    pub category_id: i32,
    pub blueprint_count: u32,
}

// ─── SdeDb ───────────────────────────────────────────────────────────────────

/// Thread-safe handle to the SDE SQLite connection.
/// Register with `app.manage(SdeDb::open(path)?)` during setup.
pub struct SdeDb(Mutex<Connection>);

impl SdeDb {
    /// Open the SDE database at `path` and create query indexes.
    pub fn open(path: &Path) -> SdeResult<Self> {
        // Open read-write so we can create indexes on first open, then we
        // never write again. Using OpenFlags avoids the PRAGMA query_only
        // dance which is unreliable across SQLite versions.
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.execute_batch("PRAGMA cache_size = -8000;")?;
        let db = Self(Mutex::new(conn));
        db.ensure_indexes()?;
        Ok(db)
    }

    fn conn(&self) -> SdeResult<std::sync::MutexGuard<'_, Connection>> {
        self.0.lock().map_err(|_| SdeError::NotAvailable)
    }

    /// Create indexes that make the solver queries fast.
    /// Safe to call every launch — all statements use `IF NOT EXISTS`.
    fn ensure_indexes(&self) -> SdeResult<()> {
        self.conn()?.execute_batch(
            "
            CREATE INDEX IF NOT EXISTS idx_iam_bp  ON industryActivityMaterials (blueprintTypeID, activityID);
            CREATE INDEX IF NOT EXISTS idx_iap_bp  ON industryActivityProducts  (blueprintTypeID, activityID);
            CREATE INDEX IF NOT EXISTS idx_iap_prod ON industryActivityProducts (productTypeID,   activityID);
            CREATE INDEX IF NOT EXISTS idx_ias_bp  ON industryActivitySkills    (blueprintTypeID, activityID);
            CREATE INDEX IF NOT EXISTS idx_ia_bp   ON industryActivities        (blueprintTypeID, activityID);
            CREATE INDEX IF NOT EXISTS idx_it_type    ON invTypes                  (typeID);
            CREATE INDEX IF NOT EXISTS idx_iap_act    ON industryActivityProducts  (activityID, productTypeID);
            CREATE INDEX IF NOT EXISTS idx_invg_cat   ON invGroups                 (categoryID);
            ",
        )?;
        Ok(())
    }
}

// ─── Type queries ─────────────────────────────────────────────────────────────

impl SdeDb {
    /// Look up name, group, category, and volume for a type.
    pub fn get_type_info(&self, type_id: TypeId) -> SdeResult<Option<SdeTypeInfo>> {
        self.conn()?.query_row(
            "SELECT t.typeID, t.typeName, t.groupID, g.categoryID,
                    CAST(t.volume AS REAL), t.published
             FROM invTypes t
             JOIN invGroups g ON g.groupID = t.groupID
             WHERE t.typeID = ?1",
            [type_id],
            row_to_type_info,
        )
        .optional()
        .map_err(Into::into)
    }

    /// Look up multiple types in one query, returning a `Vec` in arbitrary order.
    pub fn get_type_infos(&self, type_ids: &[TypeId]) -> SdeResult<Vec<SdeTypeInfo>> {
        if type_ids.is_empty() {
            return Ok(vec![]);
        }
        let placeholders = type_ids
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT t.typeID, t.typeName, t.groupID, g.categoryID,
                    CAST(t.volume AS REAL), t.published
             FROM invTypes t
             JOIN invGroups g ON g.groupID = t.groupID
             WHERE t.typeID IN ({placeholders})"
        );
        let conn = self.conn()?;
        let mut stmt = conn.prepare(&sql)?;
        let params: Vec<&dyn rusqlite::ToSql> =
            type_ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params.as_slice(), row_to_type_info)?;
        rows.collect::<Result<_, _>>().map_err(Into::into)
    }
}

fn row_to_type_info(row: &Row) -> rusqlite::Result<SdeTypeInfo> {
    let published_raw: String = row.get(5)?;
    Ok(SdeTypeInfo {
        type_id: row.get(0)?,
        type_name: row.get(1)?,
        group_id: row.get(2)?,
        category_id: row.get(3)?,
        volume: row.get(4)?,
        published: published_raw == "1" || published_raw.eq_ignore_ascii_case("true"),
    })
}

// ─── Blueprint queries ────────────────────────────────────────────────────────

impl SdeDb {
    /// Return metadata for a blueprint type from `industryBlueprints`.
    pub fn get_blueprint_info(
        &self,
        blueprint_type_id: TypeId,
    ) -> SdeResult<Option<SdeBlueprintInfo>> {
        self.conn()?
            .query_row(
                "SELECT blueprintTypeID, CAST(maxProductionLimit AS INTEGER)
                 FROM industryBlueprints
                 WHERE blueprintTypeID = ?1",
                [blueprint_type_id],
                |row| {
                    Ok(SdeBlueprintInfo {
                        blueprint_type_id: row.get(0)?,
                        max_production_limit: row.get::<_, u32>(1)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    /// Find the blueprint type ID that produces `product_type_id` via
    /// `activity` (typically `Manufacturing` or `Reaction`).
    ///
    /// Returns `None` if the type has no blueprint (raw material, PI output, etc.)
    pub fn find_blueprint_for_product(
        &self,
        product_type_id: TypeId,
        activity: ActivityId,
    ) -> SdeResult<Option<TypeId>> {
        self.conn()?
            .query_row(
                "SELECT blueprintTypeID FROM industryActivityProducts
                 WHERE productTypeID = ?1 AND activityID = ?2
                 LIMIT 1",
                rusqlite::params![product_type_id, activity as u8],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }
}

// ─── Activity queries ─────────────────────────────────────────────────────────

impl SdeDb {
    /// Materials required for one run of `activity` on `blueprint_type_id`.
    pub fn get_activity_materials(
        &self,
        blueprint_type_id: TypeId,
        activity: ActivityId,
    ) -> SdeResult<Vec<SdeMaterial>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT materialTypeID, CAST(quantity AS INTEGER)
             FROM industryActivityMaterials
             WHERE blueprintTypeID = ?1 AND activityID = ?2",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![blueprint_type_id, activity as u8],
            |row| {
                Ok(SdeMaterial {
                    material_type_id: row.get(0)?,
                    quantity: row.get::<_, u64>(1)?,
                })
            },
        )?;
        rows.collect::<Result<_, _>>().map_err(Into::into)
    }

    /// Products yielded by one run of `activity` on `blueprint_type_id`.
    /// Manufacturing has one product; invention may have < 1.0 probability.
    pub fn get_activity_products(
        &self,
        blueprint_type_id: TypeId,
        activity: ActivityId,
    ) -> SdeResult<Vec<SdeProduct>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT productTypeID,
                    CAST(quantity AS INTEGER),
                    CAST(probability AS REAL)
             FROM industryActivityProducts
             WHERE blueprintTypeID = ?1 AND activityID = ?2",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![blueprint_type_id, activity as u8],
            |row| {
                let prob: Option<f64> = row.get(2)?;
                Ok(SdeProduct {
                    product_type_id: row.get(0)?,
                    quantity: row.get::<_, u64>(1)?,
                    probability: prob.filter(|&p| p < 1.0),
                })
            },
        )?;
        rows.collect::<Result<_, _>>().map_err(Into::into)
    }

    /// Base job duration in seconds for `activity` on `blueprint_type_id`.
    pub fn get_activity_time(
        &self,
        blueprint_type_id: TypeId,
        activity: ActivityId,
    ) -> SdeResult<Option<u32>> {
        self.conn()?
            .query_row(
                "SELECT CAST(time AS INTEGER)
                 FROM industryActivities
                 WHERE blueprintTypeID = ?1 AND activityID = ?2",
                rusqlite::params![blueprint_type_id, activity as u8],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    /// Skill requirements for `activity` on `blueprint_type_id`.
    pub fn get_activity_skills(
        &self,
        blueprint_type_id: TypeId,
        activity: ActivityId,
    ) -> SdeResult<Vec<SdeSkillReq>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT skillTypeID, CAST(level AS INTEGER)
             FROM industryActivitySkills
             WHERE blueprintTypeID = ?1 AND activityID = ?2",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![blueprint_type_id, activity as u8],
            |row| {
                Ok(SdeSkillReq {
                    skill_type_id: row.get(0)?,
                    level: row.get::<_, u8>(1)?,
                })
            },
        )?;
        rows.collect::<Result<_, _>>().map_err(Into::into)
    }
}

// ─── Type search ──────────────────────────────────────────────────────────────

impl SdeDb {
    /// Search published types by name (case-insensitive substring match).
    /// Results are ordered by name length then alphabetically so shorter /
    /// exact matches appear first.
    pub fn search_types(&self, query: &str, limit: usize) -> SdeResult<Vec<SdeTypeInfo>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT t.typeID, t.typeName, t.groupID, g.categoryID,
                    CAST(t.volume AS REAL), t.published
             FROM invTypes t
             JOIN invGroups g ON g.groupID = t.groupID
             WHERE t.typeName LIKE ?1 AND (t.published = '1' OR t.published = 'true')
             ORDER BY length(t.typeName), t.typeName
             LIMIT ?2",
        )?;
        let pattern = format!("%{query}%");
        let rows =
            stmt.query_map(rusqlite::params![pattern, limit as i64], row_to_type_info)?;
        rows.collect::<Result<_, _>>().map_err(Into::into)
    }
}

// ─── Blueprint browser queries ────────────────────────────────────────────────

impl SdeDb {
    /// Return all distinct product categories that have at least one
    /// manufacturing (1) or reaction (11) blueprint, ordered by name.
    pub fn get_industry_categories(&self) -> SdeResult<Vec<SdeCategory>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT g.categoryID, c.categoryName,
                    COUNT(DISTINCT iap.blueprintTypeID) AS blueprint_count
             FROM industryActivityProducts iap
             JOIN invTypes pt ON pt.typeID = iap.productTypeID
             JOIN invGroups g  ON g.groupID  = pt.groupID
             JOIN invCategories c ON c.categoryID = g.categoryID
             WHERE iap.activityID IN (1, 11)
               AND (pt.published = '1' OR pt.published = 'true')
             GROUP BY g.categoryID, c.categoryName
             ORDER BY c.categoryName",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(SdeCategory {
                category_id: row.get(0)?,
                category_name: row.get(1)?,
                blueprint_count: row.get(2)?,
            })
        })?;
        rows.collect::<Result<_, _>>().map_err(Into::into)
    }

    /// Return all product groups within a category that have at least one
    /// manufacturing or reaction blueprint.
    pub fn get_industry_groups(&self, category_id: i32) -> SdeResult<Vec<SdeGroup>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT g.groupID, g.groupName, g.categoryID,
                    COUNT(DISTINCT iap.blueprintTypeID) AS blueprint_count
             FROM industryActivityProducts iap
             JOIN invTypes pt ON pt.typeID = iap.productTypeID
             JOIN invGroups g  ON g.groupID  = pt.groupID
             WHERE iap.activityID IN (1, 11)
               AND g.categoryID = ?1
               AND (pt.published = '1' OR pt.published = 'true')
             GROUP BY g.groupID, g.groupName
             ORDER BY g.groupName",
        )?;
        let rows = stmt.query_map([category_id], |row| {
            Ok(SdeGroup {
                group_id: row.get(0)?,
                group_name: row.get(1)?,
                category_id: row.get(2)?,
                blueprint_count: row.get(3)?,
            })
        })?;
        rows.collect::<Result<_, _>>().map_err(Into::into)
    }

    /// Browse blueprints with optional filters.
    ///
    /// - `category_id` — restrict to blueprints whose product is in this category.
    /// - `group_id`    — restrict to blueprints whose product is in this group.
    /// - `query`       — each whitespace-separated word must appear in the product
    ///                   name or blueprint name (AND logic, case-insensitive LIKE).
    ///                   Trailing 's' is stripped from each word so "fuel blocks"
    ///                   matches "Caldari Fuel Block".
    /// - `limit`       — max results (capped to prevent runaway queries).
    pub fn browse_blueprints(
        &self,
        category_id: Option<i32>,
        group_id: Option<i32>,
        query: Option<&str>,
        owned_ids: Option<&[TypeId]>,
        limit: usize,
    ) -> SdeResult<Vec<SdeBlueprintEntry>> {
        let conn = self.conn()?;

        // Split query into per-word LIKE patterns.  Strip trailing 's' so that
        // "fuel blocks" matches "Caldari Fuel Block", "ships" matches "Ship", etc.
        let word_patterns: Vec<String> = query
            .map(|q| {
                q.split_whitespace()
                    .map(|w| {
                        let stem = if w.len() > 3 && w.ends_with('s') {
                            &w[..w.len() - 1]
                        } else {
                            w
                        };
                        format!("%{stem}%")
                    })
                    .collect()
            })
            .unwrap_or_default();

        // Build dynamic SQL: one AND clause per word, starting at param ?3.
        let word_clauses: String = (0..word_patterns.len())
            .map(|i| {
                let p = 3 + i; // ?3, ?4, …
                format!("AND (pt.typeName LIKE ?{p} OR bt.typeName LIKE ?{p})")
            })
            .collect::<Vec<_>>()
            .join("\n             ");

        // Optional IN filter for owned blueprint type IDs.
        let owned_start = 3 + word_patterns.len();
        let owned_clause = match owned_ids {
            Some(ids) if !ids.is_empty() => {
                let placeholders = (0..ids.len())
                    .map(|i| format!("?{}", owned_start + i))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("AND iap.blueprintTypeID IN ({placeholders})")
            }
            _ => String::new(),
        };

        let limit_param = owned_start + owned_ids.map_or(0, |ids| ids.len());
        let sql = format!(
            "SELECT iap.blueprintTypeID, bt.typeName,
                    iap.productTypeID,   pt.typeName,
                    g.groupID,           g.groupName,
                    g.categoryID,        c.categoryName,
                    CAST(COALESCE(ib.maxProductionLimit, 0) AS INTEGER),
                    iap.activityID
             FROM industryActivityProducts iap
             JOIN invTypes bt       ON bt.typeID       = iap.blueprintTypeID
             JOIN invTypes pt       ON pt.typeID       = iap.productTypeID
             JOIN invGroups g       ON g.groupID       = pt.groupID
             JOIN invCategories c   ON c.categoryID    = g.categoryID
             LEFT JOIN industryBlueprints ib ON ib.blueprintTypeID = iap.blueprintTypeID
             WHERE iap.activityID IN (1, 11)
               AND (pt.published = '1' OR pt.published = 'true')
               AND (bt.published = '1' OR bt.published = 'true')
               AND (?1 IS NULL OR g.categoryID = ?1)
               AND (?2 IS NULL OR g.groupID    = ?2)
             {word_clauses}
             {owned_clause}
             ORDER BY c.categoryName, g.groupName, pt.typeName
             LIMIT ?{limit_param}",
        );

        let mut stmt = conn.prepare(&sql)?;
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![
            Box::new(category_id),
            Box::new(group_id),
        ];
        for p in &word_patterns {
            params.push(Box::new(p.clone()));
        }
        if let Some(ids) = owned_ids {
            for &id in ids {
                params.push(Box::new(id));
            }
        }
        params.push(Box::new(limit as i64));

        let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(param_refs.as_slice(), |row| {
                Ok(SdeBlueprintEntry {
                    blueprint_type_id:    row.get(0)?,
                    blueprint_name:       row.get(1)?,
                    product_type_id:      row.get(2)?,
                    product_name:         row.get(3)?,
                    group_id:             row.get(4)?,
                    group_name:           row.get(5)?,
                    category_id:          row.get(6)?,
                    category_name:        row.get(7)?,
                    max_production_limit: row.get::<_, u32>(8)?,
                    activity_id:          row.get::<_, u8>(9)?,
                })
            })?;
        rows.collect::<Result<_, _>>().map_err(Into::into)
    }
}

// ─── Managed state wrapper ────────────────────────────────────────────────────

/// Tauri managed state for the SDE database.
///
/// Wraps `Option<SdeDb>` because the SDE may not be downloaded on first launch.
/// Commands check `None` and return a `SdeNotAvailable` error. The option is
/// replaced in-place when a background SDE update completes.
///
/// The inner `Arc<Mutex<…>>` lets background tasks clone the Arc and hold it
/// across async awaits without borrowing the `State<'_, SdeState>` handle.
pub struct SdeState(pub std::sync::Arc<std::sync::Mutex<Option<SdeDb>>>);

impl SdeState {
    pub fn new(db: Option<SdeDb>) -> Self {
        Self(std::sync::Arc::new(std::sync::Mutex::new(db)))
    }
}
