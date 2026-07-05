// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { create } from "zustand";
import {
  getMarketRegions,
  saveMarketRegion,
  deleteMarketRegion,
  fetchMarketPrices,
  fetchPriceHistory,
} from "../api";
import type { MarketHistoryEntry, MarketRegion, MarketPriceEntry, TypeId } from "../api";

// Prices keyed by "regionId:typeId" for O(1) lookup.
type PriceKey = string;
function priceKey(regionId: number, typeId: TypeId): PriceKey {
  return `${regionId}:${typeId}`;
}

// History keyed by "regionId:typeId" → sorted array (newest first)
type HistoryKey = string;
function historyKey(regionId: number, typeId: TypeId): HistoryKey {
  return `${regionId}:${typeId}`;
}

interface MarketState {
  regions: MarketRegion[];
  prices: Record<PriceKey, MarketPriceEntry>;
  /** Price entries grouped by typeId for O(1) lookup via getPricesForType. */
  byType: Record<TypeId, MarketPriceEntry[]>;
  /** Price history: keyed by "regionId:typeId", entries sorted newest-first. */
  history: Record<HistoryKey, MarketHistoryEntry[]>;
  loading: boolean;
  fetching: boolean;
  fetchingHistory: boolean;
  error: string | null;

  // ── Actions ────────────────────────────────────────────────────────────────
  loadRegions: () => Promise<void>;
  saveRegion: (region: MarketRegion) => Promise<void>;
  removeRegion: (id: string) => Promise<void>;

  /** Fetch prices for the given type IDs across all configured regions. */
  fetchPrices: (typeIds: TypeId[]) => Promise<void>;
  /** Fetch price history for the given type IDs (background, non-blocking). */
  fetchHistory: (typeIds: TypeId[]) => Promise<void>;

  /** Look up cached best sell price for a type in a specific region. */
  getBestSell: (regionId: number, typeId: TypeId) => number | null;
  /** Look up cached best buy price for a type in a specific region. */
  getBestBuy: (regionId: number, typeId: TypeId) => number | null;
  /** Get all price entries for a type across all regions. */
  getPricesForType: (typeId: TypeId) => MarketPriceEntry[];
  /** Get history entries for a type in a specific region (newest first). */
  getHistory: (regionId: number, typeId: TypeId) => MarketHistoryEntry[];
}

export const useMarketStore = create<MarketState>((set, get) => ({
  regions: [],
  prices: {},
  byType: {},
  history: {},
  loading: false,
  fetching: false,
  fetchingHistory: false,
  error: null,

  loadRegions: async () => {
    set({ loading: true, error: null });
    try {
      const regions = await getMarketRegions();
      set({ regions, loading: false });
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },

  saveRegion: async (region) => {
    try {
      await saveMarketRegion(region);
      set((s) => {
        const rest = s.regions.filter((r) => r.id !== region.id);
        return { regions: [...rest, region].sort((a, b) =>
          (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0) || a.label.localeCompare(b.label)
        )};
      });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  removeRegion: async (id) => {
    try {
      await deleteMarketRegion(id);
      set((s) => ({ regions: s.regions.filter((r) => r.id !== id) }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  fetchPrices: async (typeIds) => {
    if (typeIds.length === 0) return;
    set({ fetching: true, error: null });
    try {
      const entries = await fetchMarketPrices(typeIds);
      set((s) => {
        const prices = { ...s.prices };
        const byType = { ...s.byType };
        for (const entry of entries) {
          prices[priceKey(entry.regionId, entry.typeId)] = entry;
          const list = byType[entry.typeId] ? [...byType[entry.typeId]] : [];
          const idx = list.findIndex((e) => e.regionId === entry.regionId);
          if (idx >= 0) list[idx] = entry; else list.push(entry);
          byType[entry.typeId] = list;
        }
        return { prices, byType, fetching: false };
      });
    } catch (e) {
      set({ fetching: false, error: String(e) });
    }
  },

  fetchHistory: async (typeIds) => {
    if (typeIds.length === 0) return;
    set({ fetchingHistory: true });
    try {
      const entries = await fetchPriceHistory(typeIds);
      set((s) => {
        const history = { ...s.history };
        for (const entry of entries) {
          const key = historyKey(entry.regionId, entry.typeId);
          if (!history[key]) history[key] = [];
          history[key].push(entry);
        }
        // Sort each key newest-first and deduplicate by date.
        for (const key of Object.keys(history)) {
          const seen = new Set<string>();
          history[key] = history[key]
            .filter((e) => { const dup = seen.has(e.date); seen.add(e.date); return !dup; })
            .sort((a, b) => b.date.localeCompare(a.date));
        }
        return { history, fetchingHistory: false };
      });
    } catch {
      set({ fetchingHistory: false });
    }
  },

  getBestSell: (regionId, typeId) => {
    return get().prices[priceKey(regionId, typeId)]?.bestSell ?? null;
  },

  getBestBuy: (regionId, typeId) => {
    return get().prices[priceKey(regionId, typeId)]?.bestBuy ?? null;
  },

  getPricesForType: (typeId) => {
    return get().byType[typeId] ?? [];
  },

  getHistory: (regionId, typeId) => {
    return get().history[historyKey(regionId, typeId)] ?? [];
  },
}));