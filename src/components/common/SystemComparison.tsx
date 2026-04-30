import { useEffect, useState } from "react";
import {
  getWatchedSystems, addWatchedSystem, removeWatchedSystem, getSystemCostInfo,
} from "../../api";
import type { WatchedSystem, SystemCostInfo, SystemSearchResult } from "../../api";
import { useMarketStore } from "../../store/market";
import { SystemPicker } from "./SystemPicker";
import "./SystemComparison.css";

interface WatchedEntry {
  system:    WatchedSystem;
  costInfo:  SystemCostInfo | null;
  loading:   boolean;
}

interface Props {
  /** If provided, highlight this system as "current" (e.g. from the active structure profile). */
  currentSystemId?: number | null;
}

export function SystemComparison({ currentSystemId }: Props) {
  const [entries,   setEntries]   = useState<WatchedEntry[]>([]);
  const [pickerKey, setPickerKey] = useState(0);
  const loadRegions = useMarketStore((s) => s.loadRegions);

  // Load persisted watched systems on mount — they already carry name + regionId.
  useEffect(() => {
    getWatchedSystems().then((systems) => {
      setEntries(systems.map((s) => ({ system: s, costInfo: null, loading: true })));
    }).catch(() => {});
  }, []);

  // Fetch cost index data for any entries that are still loading.
  useEffect(() => {
    for (const entry of entries) {
      if (!entry.loading) continue;
      getSystemCostInfo(entry.system.systemId).then((info) => {
        setEntries((prev) =>
          prev.map((e) =>
            e.system.systemId === entry.system.systemId
              ? { ...e, costInfo: info, loading: false }
              : e,
          ),
        );
      }).catch(() => {
        setEntries((prev) =>
          prev.map((e) =>
            e.system.systemId === entry.system.systemId
              ? { ...e, loading: false }
              : e,
          ),
        );
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries.length]);

  async function handleAdd(result: SystemSearchResult) {
    if (entries.some((e) => e.system.systemId === result.systemId)) return;

    // Show optimistic entry immediately so the user sees feedback while ESI resolves.
    const optimistic: WatchedSystem = { systemId: result.systemId, systemName: result.systemName, regionId: null };
    setEntries((prev) => [...prev, { system: optimistic, costInfo: null, loading: true }]);
    setPickerKey((k) => k + 1);

    // Resolve name + region server-side (may take a moment — 2–3 ESI calls).
    const system = await addWatchedSystem(result.systemId).catch(() => null);
    if (system) {
      // Update entry with resolved data (region ID may now be set).
      setEntries((prev) =>
        prev.map((e) => e.system.systemId === result.systemId ? { ...e, system } : e),
      );
      if (system.regionId !== null) loadRegions().catch(() => {});
    }
  }

  async function handleRemove(systemId: number) {
    await removeWatchedSystem(systemId).catch(() => {});
    setEntries((prev) => prev.filter((e) => e.system.systemId !== systemId));
    loadRegions().catch(() => {});
  }

  // Sort: current system first, then by manufacturing cost index ascending.
  const sorted = [...entries].sort((a, b) => {
    if (a.system.systemId === currentSystemId) return -1;
    if (b.system.systemId === currentSystemId) return 1;
    const ai = a.costInfo?.manufacturing ?? Infinity;
    const bi = b.costInfo?.manufacturing ?? Infinity;
    return (ai ?? Infinity) - (bi ?? Infinity);
  });

  return (
    <div className="syscmp">
      <div className="syscmp-add">
        <SystemPicker
          key={pickerKey}
          placeholder="Enter solar system name…"
          currentName={null}
          onSelect={handleAdd}
        />
      </div>

      {entries.length === 0 ? (
        <div className="syscmp-empty">
          No systems tracked. Add a solar system to compare cost indices and market prices across hubs.
        </div>
      ) : (
        <div className="syscmp-table">
          <div className="syscmp-header">
            <span>System</span>
            <span className="syscmp-right" title="Manufacturing cost index. Job cost = item value × index × facility tax. Lower is cheaper.">Mfg Index</span>
            <span className="syscmp-right" title="Reaction cost index for moon material processing jobs.">React Index</span>
            <span />
          </div>
          {sorted.map((entry) => {
            const isCurrent = entry.system.systemId === currentSystemId;
            const mfgIdx    = entry.costInfo?.manufacturing ?? null;
            const reactIdx  = entry.costInfo?.reaction ?? null;
            const mfgHigh   = mfgIdx !== null && mfgIdx > 0.05;
            const reactHigh = reactIdx !== null && reactIdx > 0.05;
            const hasMarket = entry.system.regionId !== null;

            return (
              <div
                key={entry.system.systemId}
                className={`syscmp-row${isCurrent ? " syscmp-row-current" : ""}`}
              >
                <span className="syscmp-name">
                  {entry.loading
                    ? <span className="syscmp-loading">{entry.system.systemName}</span>
                    : entry.system.systemName
                  }
                  {isCurrent && (
                    <span className="syscmp-current-badge" title="This is the system used by your active structure profile">current</span>
                  )}
                  {hasMarket && (
                    <span className="syscmp-market-badge" title="This system's region is included in market hub price comparisons">market</span>
                  )}
                </span>
                <span className={`syscmp-right syscmp-idx${mfgHigh ? " syscmp-idx-high" : mfgIdx !== null ? " syscmp-idx-ok" : ""}`}>
                  {mfgIdx !== null ? `${(mfgIdx * 100).toFixed(2)}%` : "—"}
                </span>
                <span className={`syscmp-right syscmp-idx${reactHigh ? " syscmp-idx-high" : reactIdx !== null ? " syscmp-idx-ok" : ""}`}>
                  {reactIdx !== null ? `${(reactIdx * 100).toFixed(2)}%` : "—"}
                </span>
                <span className="syscmp-actions">
                  <button
                    className="syscmp-remove"
                    onClick={() => handleRemove(entry.system.systemId)}
                    title="Remove from comparison"
                  >
                    ×
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
