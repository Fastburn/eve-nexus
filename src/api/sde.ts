import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  SdeDownloadProgress,
  SdeImportProgress,
  SdeStatus,
  SdeUpdateResult,
  SdeVersionInfo,
  TypeSummary,
} from "./types";

/** Check whether the SDE has been downloaded and is ready to query. */
export async function getSdeStatus(): Promise<SdeStatus> {
  return invoke<SdeStatus>("get_sde_status");
}

/**
 * Return the installed SDE build number and dates.
 * Returns null if the SDE has never been downloaded.
 */
export async function getSdeVersion(): Promise<SdeVersionInfo | null> {
  return invoke<SdeVersionInfo | null>("get_sde_version");
}

/**
 * Trigger a manual SDE version check and download if stale.
 * Progress is reported via the event listeners below.
 * The result is also emitted on "sde://result" when complete.
 */
export async function triggerSdeUpdate(): Promise<void> {
  await invoke("trigger_sde_update");
}

/**
 * Batch-fetch type names for a list of typeIds.
 * Returns a map of typeId → typeName for types that exist in the SDE.
 */
export async function getTypeNames(
  typeIds: number[],
): Promise<Record<number, string>> {
  if (typeIds.length === 0) return {};
  return invoke<Record<number, string>>("get_type_names", { typeIds });
}

/** Search published SDE types by name. Returns up to 50 results. */
export async function searchTypes(query: string): Promise<TypeSummary[]> {
  if (!query.trim()) return [];
  return invoke<TypeSummary[]>("search_types", { query });
}

// ── SDE event listeners ───────────────────────────────────────────────────────

/**
 * Listen for SDE download progress.
 * Returns an unlisten function — call it to stop listening.
 */
export function onSdeDownloadProgress(
  cb: (progress: SdeDownloadProgress) => void,
): Promise<() => void> {
  return listen<SdeDownloadProgress>("sde://progress", (e) => cb(e.payload));
}

/**
 * Listen for SDE table import progress.
 * Returns an unlisten function — call it to stop listening.
 */
export function onSdeImportProgress(
  cb: (progress: SdeImportProgress) => void,
): Promise<() => void> {
  return listen<SdeImportProgress>("sde://import-progress", (e) =>
    cb(e.payload),
  );
}

/**
 * Listen for the SDE update result (fires once per check_and_update run).
 * Returns an unlisten function — call it to stop listening.
 */
export function onSdeResult(
  cb: (result: SdeUpdateResult) => void,
): Promise<() => void> {
  return listen<SdeUpdateResult>("sde://result", (e) => cb(e.payload));
}
