import { invoke } from "@tauri-apps/api/core";
import type { SystemSearchResult, SystemCostInfo, CheapestSystemEntry, WatchedSystem } from "./types";

export function searchSolarSystems(query: string): Promise<SystemSearchResult[]> {
  return invoke("search_solar_systems", { query });
}

export function getSystemCostInfo(systemId: number): Promise<SystemCostInfo | null> {
  return invoke("get_system_cost_info", { systemId });
}

export function getCheapestSystems(
  activity: "manufacturing" | "reaction",
  limit: number,
): Promise<CheapestSystemEntry[]> {
  return invoke("get_cheapest_systems", { activity, limit });
}

export function getWatchedSystems(): Promise<WatchedSystem[]> {
  return invoke("get_watched_systems");
}

/** Add a system to the watch list. Returns the resolved system info (name + region). */
export function addWatchedSystem(systemId: number): Promise<WatchedSystem> {
  return invoke("add_watched_system", { systemId });
}

export function removeWatchedSystem(systemId: number): Promise<void> {
  return invoke("remove_watched_system", { systemId });
}
