// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppUpdateInfo, AppUpdateProgress } from "./types";

/**
 * Check whether a newer version of the app is available.
 * Returns null if already on the latest version.
 */
export async function checkForAppUpdate(): Promise<AppUpdateInfo | null> {
  return invoke<AppUpdateInfo | null>("check_for_app_update");
}

/**
 * Download and install the pending update, then relaunch the app.
 * Progress is reported via onAppUpdateProgress listeners.
 * After the install completes Tauri relaunches automatically —
 * the frontend does not need to do anything further.
 */
export async function installAppUpdate(): Promise<void> {
  return invoke("install_app_update");
}

/**
 * Listen for download progress while an app update is being installed.
 * Returns an unlisten function — call it to stop listening.
 */
export function onAppUpdateProgress(
  cb: (progress: AppUpdateProgress) => void,
): Promise<() => void> {
  return listen<AppUpdateProgress>("app-update://progress", (e) =>
    cb(e.payload),
  );
}
export type UpdateChannel = "stable" | "beta";

/**
 * The update channel in effect. Defaults to "beta" on beta builds and
 * "stable" otherwise until the user picks one in Settings.
 */
export async function getUpdateChannel(): Promise<UpdateChannel> {
  return invoke<UpdateChannel>("get_update_channel");
}
export async function setUpdateChannel(channel: UpdateChannel): Promise<void> {
  return invoke("set_update_channel", { channel });
}
