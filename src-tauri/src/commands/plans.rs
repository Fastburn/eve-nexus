//! Production plan CRUD commands — create, read, update, delete plans stored
//! in the local SQLite database.

use tauri::State;
use crate::db::local::{LocalState, PlanSummary, ProductionPlan};
use super::CommandError;

/// Return lightweight summaries of all saved plans (no target details).
#[tauri::command]
pub fn list_plans(local: State<'_, LocalState>) -> Result<Vec<PlanSummary>, CommandError> {
    local.0.list_plans().map_err(Into::into)
}

/// Load a full plan by ID, including all build targets.
/// Returns `None` if no plan with that ID exists.
#[tauri::command]
pub fn get_plan(
    id: String,
    local: State<'_, LocalState>,
) -> Result<Option<ProductionPlan>, CommandError> {
    local.0.get_plan(&id).map_err(Into::into)
}

/// Create or update a plan (matched by `plan.id`).
#[tauri::command]
pub fn save_plan(
    plan: ProductionPlan,
    local: State<'_, LocalState>,
) -> Result<(), CommandError> {
    local.0.save_plan(&plan).map_err(Into::into)
}

/// Permanently delete a plan by ID.
#[tauri::command]
pub fn delete_plan(
    id: String,
    local: State<'_, LocalState>,
) -> Result<(), CommandError> {
    local.0.delete_plan(&id).map_err(Into::into)
}
