//! User settings commands — analytics consent, first-run wizard state,
//! global plan defaults (overproduction multiplier, freight rate), and the
//! app data folder helper.

use tauri::{AppHandle, State};
use crate::db::local::{
    AnalyticsConsent, LocalState,
    SETTING_WIZARD_COMPLETED,
    SETTING_DEFAULT_MULTIPLIER, SETTING_DEFAULT_FREIGHT_ISK_PER_M3,
};
use super::CommandError;

// ─── First-run wizard ─────────────────────────────────────────────────────────

/// Returns `true` if the user has completed the first-run wizard.
///
/// Checked on every launch — if `false`, the wizard is shown regardless of
/// whether the app was freshly installed or upgraded from a beta version.
#[tauri::command]
pub fn get_wizard_completed(local: State<'_, LocalState>) -> Result<bool, CommandError> {
    let val = local.0.get_setting(SETTING_WIZARD_COMPLETED).map_err(CommandError::from)?;
    Ok(val.as_deref() == Some("true"))
}

/// Mark the first-run wizard as completed. Called when the user finishes the
/// final wizard step; never shown again after this.
#[tauri::command]
pub fn set_wizard_completed(local: State<'_, LocalState>) -> Result<(), CommandError> {
    local.0.set_setting(SETTING_WIZARD_COMPLETED, "true").map_err(CommandError::from)
}

// ─── Analytics consent ────────────────────────────────────────────────────────

/// Return the current analytics opt-in state: Pending | Granted | Denied.
/// `Pending` means the user hasn't answered yet (first-run wizard not done).
#[tauri::command]
pub fn get_analytics_consent(local: State<'_, LocalState>) -> Result<AnalyticsConsent, CommandError> {
    local.0.get_analytics_consent().map_err(Into::into)
}

/// Set analytics consent. `Granted` allows anonymous launch pings to Plausible.
/// `Denied` ensures no data is ever sent. Can also be changed in Settings.
#[tauri::command]
pub fn set_analytics_consent(
    consent: AnalyticsConsent,
    local: State<'_, LocalState>,
) -> Result<(), CommandError> {
    local.0.set_analytics_consent(consent).map_err(Into::into)
}

// ─── Global plan defaults ─────────────────────────────────────────────────────

/// Get the global default overproduction multiplier (1.0 = exact quantity, no buffer stock).
#[tauri::command]
pub fn get_default_overproduction_multiplier(local: State<'_, LocalState>) -> Result<f64, CommandError> {
    let v = local.0
        .get_setting(SETTING_DEFAULT_MULTIPLIER)
        .map_err(CommandError::from)?
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(1.0);
    Ok(v)
}

/// Set the global default overproduction multiplier.
#[tauri::command]
pub fn set_default_overproduction_multiplier(
    multiplier: f64,
    local: State<'_, LocalState>,
) -> Result<(), CommandError> {
    local.0.set_setting(SETTING_DEFAULT_MULTIPLIER, &multiplier.to_string()).map_err(Into::into)
}

/// Get the global default freight cost in ISK/m³ (0.0 = no freight factored in).
#[tauri::command]
pub fn get_default_freight_isk_per_m3(local: State<'_, LocalState>) -> Result<f64, CommandError> {
    let v = local.0
        .get_setting(SETTING_DEFAULT_FREIGHT_ISK_PER_M3)
        .map_err(CommandError::from)?
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);
    Ok(v)
}

/// Set the global default freight cost in ISK/m³.
#[tauri::command]
pub fn set_default_freight_isk_per_m3(
    isk_per_m3: f64,
    local: State<'_, LocalState>,
) -> Result<(), CommandError> {
    local.0.set_setting(SETTING_DEFAULT_FREIGHT_ISK_PER_M3, &isk_per_m3.to_string()).map_err(Into::into)
}

// ─── App data folder ──────────────────────────────────────────────────────────

/// Open the app's data directory in the system file manager.
/// Useful for users who want to back up plans or manually inspect the database.
#[tauri::command]
pub fn open_app_data_folder(app: AppHandle) -> Result<(), CommandError> {
    use tauri::Manager;
    use tauri_plugin_opener::OpenerExt;
    let path = app.path().app_data_dir()
        .map_err(|e| CommandError::InvalidInput { message: e.to_string() })?;
    std::fs::create_dir_all(&path).ok();
    app.opener().open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| CommandError::InvalidInput { message: e.to_string() })
}
