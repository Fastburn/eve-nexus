import { create } from "zustand";
import {
  getMarketRegions,
  saveMarketRegion,
  deleteMarketRegion,
  fetchMarketPrices,
} from "../api";
import type { MarketRegion, MarketPriceEntry, TypeId } from "../api";

// Prices keyed by "regionId:typeId" for O(1) lookup.
type PriceKey = string;
function priceKey(regionId: number, typeId: TypeId): PriceKey {
  return `${regionId}:${typeId}`;
}

interface MarketState {
  regions: MarketRegion[];
  prices: Record<PriceKey, MarketPriceEntry>;
  loading: boolean;
  fetching: boolean;
  error: string | null;

  // ── Actions ────────────────────────────────────────────────────────────────
  loadRegions: () => Promise<void>;
  saveRegion: (region: MarketRegion) => Promise<void>;
  removeRegion: (id: string) => Promise<void>;

  /** Fetch prices for the given type IDs across all configured regions. */
  fetchPrices: (typeIds: TypeId[]) => Promise<void>;

  /** Look up cached best sell price for a type in a specific region. */
  getBestSell: (regionId: number, typeId: TypeId) => number | null;
  /** Look up cached best buy price for a type in a specific region. */
  getBestBuy: (regionId: number, typeId: TypeId) => number | null;
  /** Get all price entries for a type across all regions. */
  getPricesForType: (typeId: TypeId) => MarketPriceEntry[];
}

export const useMarketStore = create<MarketState>((set, get) => ({
  regions: [],
  prices: {},
  loading: false,
  fetching: false,
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
        for (const entry of entries) {
          prices[priceKey(entry.regionId, entry.typeId)] = entry;
        }
        return { prices, fetching: false };
      });
    } catch (e) {
      set({ fetching: false, error: String(e) });
    }
  },

  getBestSell: (regionId, typeId) => {
    return get().prices[priceKey(regionId, typeId)]?.bestSell ?? null;
  },

  getBestBuy: (regionId, typeId) => {
    return get().prices[priceKey(regionId, typeId)]?.bestBuy ?? null;
  },

  getPricesForType: (typeId) => {
    return Object.values(get().prices).filter((p) => p.typeId === typeId);
  },
}));
