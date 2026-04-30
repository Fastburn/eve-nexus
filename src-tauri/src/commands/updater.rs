//! App auto-update commands — check for and install new versions via the
//! Tauri updater plugin (signed GitHub releases).

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

use super::CommandError;

/// What the frontend receives when an update is available.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub version: String,
    /// Markdown release notes from the update manifest.
    pub notes: Option<String>,
}

/// Check whether a newer version of the app is available.
///
/// Returns `Some(AppUpdateInfo)` if an update exists, `None` if already on the
/// latest version. The frontend calls this on startup and surfaces the result
/// in the update banner.
#[tauri::command]
pub async fn check_for_app_update(app: AppHandle) -> Result<Option<AppUpdateInfo>, CommandError> {
    let updater = app
        .updater()
        .map_err(|e| CommandError::InvalidInput { message: e.to_string() })?;

    let update = updater
        .check()
        .await
        .map_err(|e| CommandError::InvalidInput { message: e.to_string() })?;

    Ok(update.map(|u| AppUpdateInfo {
        version: u.version.clone(),
        notes: u.body.clone(),
    }))
}

/// Download and install the pending update, then relaunch.
///
/// Emits `app-update://progress` events during download:
/// `{ bytesReceived: number, bytesTotal: number | null }`.
///
/// After installation the app automatically relaunches.
#[tauri::command]
pub async fn install_app_update(app: AppHandle) -> Result<(), CommandError> {
    let updater = app
        .updater()
        .map_err(|e| CommandError::InvalidInput { message: e.to_string() })?;

    let update = updater
        .check()
        .await
        .map_err(|e| CommandError::InvalidInput { message: e.to_string() })?;

    let Some(update) = update else {
        return Ok(()); // nothing to install
    };

    let app_clone = app.clone();
    update
        .download_and_install(
            move |bytes_received, bytes_total| {
                let _ = app_clone.emit(
                    "app-update://progress",
                    serde_json::json!({
                        "bytesReceived": bytes_received,
                        "bytesTotal": bytes_total,
                    }),
                );
            },
            || {
                // Download finished — installation is about to begin.
                // Tauri handles the relaunch; nothing to do here.
            },
        )
        .await
        .map_err(|e| CommandError::InvalidInput { message: e.to_string() })?;

    Ok(())
}
