import { invoke } from "@tauri-apps/api/core";
import type { MarketRegion, MarketPriceEntry, StructureSearchResult, TypeId } from "./types";

export function getMarketRegions(): Promise<MarketRegion[]> {
  return invoke("get_market_regions");
}

export function saveMarketRegion(region: MarketRegion): Promise<void> {
  return invoke("save_market_region", { region });
}

export function deleteMarketRegion(id: string): Promise<void> {
  return invoke("delete_market_region", { id });
}

/**
 * Fetch (or return cached) best sell/buy prices for the given type IDs
 * across all configured market regions. Cache TTL is 5 minutes server-side.
 */
export function fetchMarketPrices(typeIds: TypeId[]): Promise<MarketPriceEntry[]> {
  return invoke("fetch_market_prices", { typeIds });
}

/**
 * Search public market structures by name prefix.
 * Requires a logged-in character. Results are cached locally after first fetch.
 */
export function searchMarketStructures(query: string): Promise<StructureSearchResult[]> {
  return invoke("search_market_structures", { query });
}

/**
 * Return player-owned structures where any authenticated character has assets.
 * Names are resolved from the local cache (populated during asset refresh).
 * Used to suggest market hubs the user is likely to care about.
 */
export function getAssetStructures(): Promise<StructureSearchResult[]> {
  return invoke("get_asset_structures");
}
