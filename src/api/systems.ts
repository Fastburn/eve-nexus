// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { invoke } from "@tauri-apps/api/core";
import type { SystemSearchResult, SystemCostInfo, CheapestSystemEntry, WatchedSystem } from "./types";

export function searchSolarSystems(query: string): Promise<SystemSearchResult[]> {
  return invoke<SystemSearchResult[]>("search_solar_systems", { query });
}

export function getSystemCostInfo(systemId: number): Promise<SystemCostInfo | null> {
  return invoke<SystemCostInfo | null>("get_system_cost_info", { systemId });
}

export function getCheapestSystems(
  activity: "manufacturing" | "reaction",
  limit: number,
): Promise<CheapestSystemEntry[]> {
  return invoke<CheapestSystemEntry[]>("get_cheapest_systems", { activity, limit });
}

export function getWatchedSystems(): Promise<WatchedSystem[]> {
  return invoke<WatchedSystem[]>("get_watched_systems");
}

/** Add a system to the watch list. Returns the resolved system info (name + region). */
export function addWatchedSystem(systemId: number): Promise<WatchedSystem> {
  return invoke<WatchedSystem>("add_watched_system", { systemId });
}

export function removeWatchedSystem(systemId: number): Promise<void> {
  return invoke<void>("remove_watched_system", { systemId });
}