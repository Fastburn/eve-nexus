// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! App auto-update commands — check for and install new versions via the
//! Tauri updater plugin (signed GitHub releases).
//!
//! Two update channels:
//! - **Stable** reads `releases/latest/download/latest.json`. GitHub's
//!   `/latest` skips prereleases, so stable users never see a beta.
//! - **Beta** reads `releases/download/updater-beta/latest.json`, a rolling
//!   release that `.github/workflows/update-channel.yml` overwrites whenever
//!   any release (beta or stable) is published. Semver puts
//!   `0.0.3-beta.3 < 0.0.3`, so beta users are carried onto stable releases.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::db::local::{LocalState, SETTING_UPDATE_CHANNEL};
use super::CommandError;

const STABLE_ENDPOINT: &str =
    "https://github.com/Fastburn/eve-nexus/releases/latest/download/latest.json";
const BETA_ENDPOINT: &str =
    "https://github.com/Fastburn/eve-nexus/releases/download/updater-beta/latest.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    Stable,
    Beta,
}

impl UpdateChannel {
    fn as_str(self) -> &'static str {
        match self {
            UpdateChannel::Stable => "stable",
            UpdateChannel::Beta => "beta",
        }
    }

    fn endpoint(self) -> &'static str {
        match self {
            UpdateChannel::Stable => STABLE_ENDPOINT,
            UpdateChannel::Beta => BETA_ENDPOINT,
        }
    }
}

/// The channel to check, from the saved setting. When unset, beta builds
/// (version has a prerelease suffix, e.g. `0.0.3-beta.3`) default to Beta so
/// testers keep receiving betas without touching Settings.
fn effective_channel(app: &AppHandle, local: &LocalState) -> Result<UpdateChannel, CommandError> {
    let saved = local.0.get_setting(SETTING_UPDATE_CHANNEL).map_err(CommandError::from)?;
    Ok(match saved.as_deref() {
        Some("beta") => UpdateChannel::Beta,
        Some("stable") => UpdateChannel::Stable,
        _ if app.package_info().version.pre.is_empty() => UpdateChannel::Stable,
        _ => UpdateChannel::Beta,
    })
}

async fn check_channel(app: &AppHandle, local: &LocalState) -> Result<Option<Update>, CommandError> {
    let channel = effective_channel(app, local)?;
    let endpoint = Url::parse(channel.endpoint())
        .map_err(|e| CommandError::InvalidInput { message: e.to_string() })?;

    app.updater_builder()
        .endpoints(vec![endpoint])
        .and_then(|b| b.build())
        .map_err(|e| CommandError::InvalidInput { message: e.to_string() })?
        .check()
        .await
        .map_err(|e| CommandError::InvalidInput { message: e.to_string() })
}

/// What the frontend receives when an update is available.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub version: String,
    /// Markdown release notes from the update manifest.
    pub notes: Option<String>,
}

/// Get the update channel in effect (saved setting, or the version-based default).
#[tauri::command]
pub fn get_update_channel(app: AppHandle, local: State<'_, LocalState>) -> Result<UpdateChannel, CommandError> {
    effective_channel(&app, &local)
}

/// Save the update channel. The frontend re-checks for updates afterwards.
#[tauri::command]
pub fn set_update_channel(channel: UpdateChannel, local: State<'_, LocalState>) -> Result<(), CommandError> {
    local.0.set_setting(SETTING_UPDATE_CHANNEL, channel.as_str()).map_err(Into::into)
}

/// Check whether a newer version of the app is available on the current channel.
///
/// Returns `Some(AppUpdateInfo)` if an update exists, `None` if already on the
/// latest version. The frontend calls this on startup and surfaces the result
/// in the update banner.
#[tauri::command]
pub async fn check_for_app_update(
    app: AppHandle,
    local: State<'_, LocalState>,
) -> Result<Option<AppUpdateInfo>, CommandError> {
    let update = check_channel(&app, &local).await?;

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
pub async fn install_app_update(app: AppHandle, local: State<'_, LocalState>) -> Result<(), CommandError> {
    let Some(update) = check_channel(&app, &local).await? else {
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
