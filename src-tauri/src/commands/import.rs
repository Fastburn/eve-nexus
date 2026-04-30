//! EFT fit import command — parses ship fitting text and resolves item names
//! to EVE type IDs via the ESI `/universe/ids/` bulk resolution endpoint.

use std::collections::HashMap;
use serde::Serialize;
use tauri::State;

use crate::esi::EsiState;
use crate::types::TypeId;
use super::CommandError;

/// A single resolved item from an imported EFT fit.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EftItem {
    pub type_id:   TypeId,
    pub type_name: String,
    pub quantity:  u32,
}

/// Result returned to the frontend after parsing an EFT fit.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EftImportResult {
    /// Items whose names were successfully resolved to type IDs.
    pub items:      Vec<EftItem>,
    /// Names ESI could not match — shown as warnings in the import preview.
    pub unresolved: Vec<String>,
}

/// Parse an EFT-format ship fitting and resolve item names to type IDs via ESI.
///
/// EFT format:
/// ```text
/// [Ship Type, Fit Name]
/// Module Name
/// Module Name
/// Drone Name x5
/// ```
///
/// The first non-empty line is always the ship header. Subsequent lines are
/// modules (qty 1 each) or items with explicit quantity (`Name xN`).
/// Duplicate names are aggregated.
///
/// Returns resolved items plus any unresolved names so the frontend can warn
/// the user before creating the plan.
#[tauri::command]
pub async fn import_eft_fit(
    eft_text: String,
    esi: State<'_, EsiState>,
) -> Result<EftImportResult, CommandError> {
    #[derive(serde::Deserialize)]
    struct IdEntry { id: i32, name: String }

    #[derive(serde::Deserialize)]
    struct IdsResponse {
        inventory_types: Option<Vec<IdEntry>>,
    }

    // ── Parse EFT ────────────────────────────────────────────────────────────
    // Preserve insertion order so the preview matches the fit order.
    let mut order: Vec<String> = Vec::new();
    let mut qty_by_name: HashMap<String, u32> = HashMap::new();

    let mut found_ship = false;
    for raw_line in eft_text.lines() {
        let line = raw_line.trim();
        if line.is_empty() { continue; }

        if !found_ship {
            // First non-empty line: "[Ship Type, Fit Name]" — extract ship type.
            found_ship = true;
            let inner = line.trim_start_matches('[').trim_end_matches(']');
            let ship_name = inner.split(',').next().unwrap_or(inner).trim().to_string();
            if !ship_name.is_empty() {
                if !qty_by_name.contains_key(&ship_name) { order.push(ship_name.clone()); }
                *qty_by_name.entry(ship_name).or_insert(0) += 1;
            }
            continue;
        }

        // Remaining lines: "Item Name" (qty 1) or "Item Name xN".
        let (name, qty) = if let Some((n, q)) = line.rsplit_once(" x") {
            if let Ok(qty) = q.parse::<u32>() { (n.trim(), qty) } else { (line, 1u32) }
        } else {
            (line, 1u32)
        };

        if !name.is_empty() {
            let key = name.to_string();
            if !qty_by_name.contains_key(&key) { order.push(key.clone()); }
            *qty_by_name.entry(key).or_insert(0) += qty;
        }
    }

    if qty_by_name.is_empty() {
        return Ok(EftImportResult { items: vec![], unresolved: vec![] });
    }

    // ── Resolve names → type IDs via ESI /universe/ids/ ──────────────────────
    // ESI accepts up to 500 names per call; fits are well under this limit.
    let names: Vec<&str> = order.iter().map(|s| s.as_str()).collect();
    let result: IdsResponse = esi.0
        .post_public("/universe/ids/", &names)
        .await
        .map_err(|e| CommandError::InvalidInput { message: e.to_string() })?;

    // Build a lowercase name → type_id map for case-insensitive matching.
    let resolved: HashMap<String, TypeId> = result
        .inventory_types
        .unwrap_or_default()
        .into_iter()
        .filter_map(|e| e.id.try_into().ok().map(|id: TypeId| (e.name.to_lowercase(), id)))
        .collect();

    let mut items: Vec<EftItem> = Vec::new();
    let mut unresolved: Vec<String> = Vec::new();

    for name in &order {
        let qty = qty_by_name[name];
        if let Some(&type_id) = resolved.get(&name.to_lowercase()) {
            items.push(EftItem { type_id, type_name: name.clone(), quantity: qty });
        } else {
            unresolved.push(name.clone());
        }
    }

    Ok(EftImportResult { items, unresolved })
}
