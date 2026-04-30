import { useEffect, useMemo, useRef, useState } from "react";
import { useMarketStore } from "../store/market";
import { useSolverStore, usePlanStore } from "../store";
import { buildTsv, copyText } from "../lib/export";
import { fmtIsk } from "../lib/format";
import { TypePicker, TypeIcon, SystemComparison } from "../components/common";
import { computeNodeCosts } from "../lib/buildCost";
import {
  getRestockRows, saveRestockTarget, deleteRestockTarget,
  getRestockMargin, setRestockMargin,
} from "../api";
import type { TypeSummary, MarketPriceEntry, BuildNode, RestockRow } from "../api";
import "./MarketView.css";

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function calcSpread(sell: number | null, buy: number | null): number | null {
  if (!sell || !buy || sell <= 0) return null;
  return ((sell - buy) / sell) * 100;
}

function findNode(roots: BuildNode[], typeId: number): BuildNode | null {
  for (const root of roots) {
    if (root.typeId === typeId) return root;
    const found = findNode(root.inputs, typeId);
    if (found) return found;
  }
  return null;
}

// ── Analysis card ─────────────────────────────────────────────────────────────

interface AnalysisProps {
  item: TypeSummary;
  isTracked: boolean;
  onTrack: (item: TypeSummary, qty: number) => void;
  onUntrack: (typeId: number) => void;
  onDismiss: () => void;
}

function AnalysisCard({ item, isTracked, onTrack, onUntrack, onDismiss }: AnalysisProps) {
  const [trackQty, setTrackQty] = useState("1");

  const regions          = useMarketStore((s) => s.regions);
  const getPricesForType = useMarketStore((s) => s.getPricesForType);
  useMarketStore((s) => s.prices); // subscribe for re-renders

  const solverNodes = useSolverStore((s) => s.nodes);

  const hubPrices = getPricesForType(item.typeId);

  const bestSellEntry = hubPrices.reduce<MarketPriceEntry | null>(
    (best, p) => (p.bestSell !== null && (best === null || p.bestSell > (best.bestSell ?? 0)) ? p : best),
    null,
  );
  const cheapestEntry = hubPrices.reduce<MarketPriceEntry | null>(
    (best, p) => (p.bestSell !== null && (best === null || p.bestSell < (best.bestSell ?? Infinity)) ? p : best),
    null,
  );
  const bestBuyEntry = hubPrices.reduce<MarketPriceEntry | null>(
    (best, p) => (p.bestBuy !== null && (best === null || p.bestBuy > (best.bestBuy ?? 0)) ? p : best),
    null,
  );

  const arbBuyPrice  = cheapestEntry?.bestSell ?? null;
  const arbSellPrice = bestBuyEntry?.bestBuy ?? null;
  const arbProfit    = arbBuyPrice && arbSellPrice ? arbSellPrice - arbBuyPrice : null;
  const arbPct       = arbBuyPrice && arbProfit !== null && arbBuyPrice > 0
    ? (arbProfit / arbBuyPrice) * 100 : null;
  const arbDiffHubs  = cheapestEntry?.regionId !== bestBuyEntry?.regionId;

  const regionLabel = (regionId: number) =>
    regions.find((r) => r.regionId === regionId)?.label ?? `Region ${regionId}`;

  function getBestSellGlobal(typeId: number): number | null {
    return getPricesForType(typeId).reduce<number | null>(
      (best, e) => e.bestSell !== null ? (best === null ? e.bestSell : Math.max(best, e.bestSell)) : best,
      null,
    );
  }

  const planNode    = findNode(solverNodes, item.typeId);
  const canBuild    = planNode?.kind.type === "manufacturing" || planNode?.kind.type === "reaction";
  const nodeCosts   = canBuild && planNode ? computeNodeCosts(planNode, getBestSellGlobal) : null;
  const buildPerUnit = nodeCosts && planNode && planNode.quantityNeeded > 0
    ? nodeCosts.buildCost / planNode.quantityNeeded : null;
  const cheapestMarket = cheapestEntry?.bestSell ?? null;

  return (
    <div className="mkt-analysis">
      {/* Header */}
      <div className="mkt-analysis-header">
        <TypeIcon typeId={item.typeId} variant="icon" size={64} displaySize={40} alt={item.typeName} />
        <div className="mkt-analysis-title">{item.typeName}</div>
        <div className="mkt-analysis-actions">
          {isTracked ? (
            <button
              className="mkt-track-btn mkt-track-btn-active"
              onClick={() => onUntrack(item.typeId)}
              title="Remove from watchlist"
            >
              ✓ Tracking — remove
            </button>
          ) : (
            <div className="mkt-track-add">
              <input
                type="number"
                className="mkt-track-qty"
                value={trackQty}
                min={1}
                onChange={(e) => setTrackQty(e.target.value)}
                title="Target stock quantity"
                placeholder="Qty"
              />
              <button
                className="mkt-track-btn"
                onClick={() => {
                  const q = parseInt(trackQty, 10);
                  onTrack(item, isNaN(q) || q < 1 ? 1 : q);
                }}
              >
                + Track
              </button>
            </div>
          )}
          <button className="mkt-analysis-dismiss" onClick={onDismiss} title="Close analysis">✕</button>
        </div>
      </div>

      {hubPrices.length === 0 ? (
        <div className="mkt-analysis-nodata">No price data — sync characters to fetch prices.</div>
      ) : (
        <>
          {/* Hub table */}
          {regions.length > 0 && (
            <div className="mkt-hub-grid">
              <div className="mkt-hub-header">
                <span className="mkt-hub-col-name">Hub</span>
                <span className="mkt-hub-col-r" title="Highest buy order — instant sell revenue">Buy Order</span>
                <span className="mkt-hub-col-r" title="Lowest sell order — price to buy immediately">Sell Order</span>
                <span className="mkt-hub-col-r" title="In-hub spread: (sell − buy) ÷ sell">Spread</span>
              </div>
              {regions.map((region) => {
                const entry = hubPrices.find((p) => p.regionId === region.regionId);
                const s     = calcSpread(entry?.bestSell ?? null, entry?.bestBuy ?? null);
                const best  = region.regionId === bestSellEntry?.regionId;
                return (
                  <div key={region.id} className={`mkt-hub-row${best ? " mkt-hub-row-best" : ""}`}>
                    <span className="mkt-hub-col-name">
                      <span className="mkt-hub-name">{region.label}</span>
                      {best && <span className="mkt-badge mkt-badge-sell">Best sell</span>}
                    </span>
                    <span className="mkt-hub-col-r mkt-buy-price">{fmtIsk(entry?.bestBuy ?? null)}</span>
                    <span className="mkt-hub-col-r mkt-sell-price">{fmtIsk(entry?.bestSell ?? null)}</span>
                    <span className={`mkt-hub-col-r${s !== null ? (s > 10 ? " mkt-spread-high" : s > 3 ? " mkt-spread-mid" : " mkt-spread-low") : ""}`}>
                      {s !== null ? `${s.toFixed(1)}%` : "—"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Summary row */}
          <div className="mkt-summary-row">
            {bestSellEntry?.bestSell && (
              <div className="mkt-summary-chip mkt-chip-sell" title="Post sell orders here for the best revenue">
                <span className="mkt-chip-label">Best to sell</span>
                <span className="mkt-chip-hub">{regionLabel(bestSellEntry.regionId)}</span>
                <span className="mkt-chip-price">{fmtIsk(bestSellEntry.bestSell)} ISK</span>
              </div>
            )}
            {cheapestEntry?.bestSell && cheapestEntry.regionId !== bestSellEntry?.regionId && (
              <div className="mkt-summary-chip mkt-chip-source" title="Cheapest place to buy this item">
                <span className="mkt-chip-label">Cheapest source</span>
                <span className="mkt-chip-hub">{regionLabel(cheapestEntry.regionId)}</span>
                <span className="mkt-chip-price">{fmtIsk(cheapestEntry.bestSell)} ISK</span>
              </div>
            )}
            {arbDiffHubs && arbProfit !== null && arbProfit > 0 && arbPct !== null && (
              <div
                className={`mkt-summary-chip mkt-chip-arb${arbPct > 5 ? " mkt-chip-arb-good" : ""}`}
                title={`Buy at ${regionLabel(cheapestEntry!.regionId)} (${fmtIsk(arbBuyPrice)}) → instant sell at ${regionLabel(bestBuyEntry!.regionId)} (${fmtIsk(arbSellPrice)})`}
              >
                <span className="mkt-chip-label">Arbitrage</span>
                <span className="mkt-chip-hub">{regionLabel(cheapestEntry!.regionId)} → {regionLabel(bestBuyEntry!.regionId)}</span>
                <span className="mkt-chip-price mkt-arb-profit">+{fmtIsk(arbProfit)} ({arbPct.toFixed(1)}%)</span>
                {arbPct < 5 && <span className="mkt-chip-warn">thin — check hauling costs</span>}
              </div>
            )}
            {arbDiffHubs && (arbProfit === null || arbProfit <= 0) && cheapestEntry && bestBuyEntry && (
              <div className="mkt-summary-chip mkt-chip-arb mkt-chip-arb-none" title="No profitable instant-flip opportunity between hubs">
                <span className="mkt-chip-label">Arbitrage</span>
                <span className="mkt-chip-hub">{regionLabel(cheapestEntry.regionId)} → {regionLabel(bestBuyEntry.regionId)}</span>
                <span className="mkt-chip-price" style={{ color: "var(--red)" }}>No opportunity</span>
              </div>
            )}
          </div>

          {/* Build vs buy */}
          {planNode && (
            <div className="mkt-bvb-inline">
              {buildPerUnit !== null ? (
                <>
                  <span className="mkt-bvb-item">
                    <span className="mkt-bvb-lbl">Build</span>
                    <span className="mkt-bvb-val">{fmtIsk(buildPerUnit)} ISK/unit</span>
                  </span>
                  {cheapestMarket && (
                    <span className="mkt-bvb-item">
                      <span className="mkt-bvb-lbl">Buy ({regionLabel(cheapestEntry!.regionId)})</span>
                      <span className="mkt-bvb-val">{fmtIsk(cheapestMarket)} ISK/unit</span>
                    </span>
                  )}
                  {cheapestMarket && (
                    <span className={`mkt-bvb-verdict ${buildPerUnit <= cheapestMarket ? "mkt-verdict-build" : "mkt-verdict-buy"}`}>
                      {buildPerUnit <= cheapestMarket
                        ? `Build saves ${fmtIsk(cheapestMarket - buildPerUnit)}/unit`
                        : `Buy saves ${fmtIsk(buildPerUnit - cheapestMarket)}/unit`}
                    </span>
                  )}
                  {bestSellEntry?.bestSell && (
                    <span className="mkt-bvb-item" title="Net margin after building and selling at best hub">
                      <span className="mkt-bvb-lbl">Sell margin</span>
                      <span className="mkt-bvb-val">
                        {fmtIsk(bestSellEntry.bestSell - buildPerUnit)}/unit
                        {" "}({((bestSellEntry.bestSell - buildPerUnit) / bestSellEntry.bestSell * 100).toFixed(1)}%)
                      </span>
                    </span>
                  )}
                </>
              ) : (
                <span className="mkt-bvb-lbl">In plan — no price data yet</span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function MarketView() {
  const [trackedRows, setTrackedRows]   = useState<RestockRow[]>([]);
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [marginPct, setMarginPct]       = useState(10);
  const [marginInput, setMarginInput]   = useState("10");
  const [editQty, setEditQty]           = useState<Record<number, string>>({});
  const [expanded, setExpanded]         = useState<Set<number>>(new Set());
  const [analysisItem, setAnalysisItem] = useState<TypeSummary | null>(null);
  const [fetchingItem, setFetchingItem] = useState(false);
  const [planCopied, setPlanCopied]         = useState(false);
  const [colCopied, setColCopied]           = useState<number | null>(null); // regionId of copied col
  const [editingFreight, setEditingFreight] = useState(false);
  const [freightInput, setFreightInput]     = useState("");
  const planCopyTimer                       = useRef<ReturnType<typeof setTimeout> | null>(null);
  const colCopyTimer                        = useRef<ReturnType<typeof setTimeout> | null>(null);

  const regions          = useMarketStore((s) => s.regions);
  const prices           = useMarketStore((s) => s.prices); // subscribe so plan totals recompute when data arrives
  const fetchPrices      = useMarketStore((s) => s.fetchPrices);
  const fetching         = useMarketStore((s) => s.fetching);
  const getPricesForType = useMarketStore((s) => s.getPricesForType);

  const solverNodes = useSolverStore((s) => s.nodes);

  const effectiveFreightIskPerM3 = usePlanStore((s) => s.effectiveFreightIskPerM3);
  const activePlan               = usePlanStore((s) => s.activePlan);
  const setPlanFreightIskPerM3   = usePlanStore((s) => s.setPlanFreightIskPerM3);

  // Flatten all buy items from the plan tree (deduplicated by typeId).
  const planBuyItems = useMemo(() => {
    const map = new Map<number, { typeName: string; qty: number; unitVolume: number }>();
    function walk(nodes: BuildNode[]) {
      for (const node of nodes) {
        if (node.quantityToBuy > 0 && !node.typeName.toLowerCase().includes("blueprint")) {
          const prev = map.get(node.typeId);
          map.set(node.typeId, {
            typeName: node.typeName,
            qty: (prev?.qty ?? 0) + node.quantityToBuy,
            unitVolume: node.unitVolume ?? 0,
          });
        }
        walk(node.inputs);
      }
    }
    walk(solverNodes);
    return [...map.entries()]
      .map(([typeId, { typeName, qty, unitVolume }]) => ({ typeId, typeName, qty, unitVolume }))
      .sort((a, b) => a.typeName.localeCompare(b.typeName));
  }, [solverNodes]);

  // Total cost per hub and overall best — recomputed whenever prices, freight, or plan changes.
  const planTotals = useMemo(() => {
    if (planBuyItems.length === 0 || regions.length === 0) return null;
    const hubTotals  = new Map<number, number>();
    const hubPartial = new Map<number, boolean>();
    let bestTotal    = 0;
    let bestPartial  = false;
    let totalQty     = 0;
    for (const { typeId, qty, unitVolume } of planBuyItems) {
      totalQty += qty;
      const freight   = unitVolume * effectiveFreightIskPerM3;
      const hubPrices = getPricesForType(typeId);
      const cheapest  = hubPrices.reduce<number | null>(
        (b, p) => p.bestSell !== null ? (b === null ? p.bestSell : Math.min(b, p.bestSell)) : b,
        null,
      );
      if (cheapest !== null) { bestTotal += qty * (cheapest + freight); }
      else                   { bestPartial = true; }
      for (const region of regions) {
        const entry = hubPrices.find((p) => p.regionId === region.regionId);
        if (entry?.bestSell) {
          hubTotals.set(region.regionId, (hubTotals.get(region.regionId) ?? 0) + qty * (entry.bestSell + freight));
        } else {
          hubPartial.set(region.regionId, true);
        }
      }
    }
    return { hubTotals, hubPartial, bestTotal, bestPartial, totalQty };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planBuyItems, regions, prices, effectiveFreightIskPerM3]);

  useEffect(() => { loadData(); loadMargin(); }, []);

  useEffect(() => {
    if (trackedRows.length === 0) return;
    fetchPrices(trackedRows.map((r) => r.typeId)).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackedRows]);

  // Fetch plan buy-item prices whenever the plan or hub list changes.
  useEffect(() => {
    if (planBuyItems.length === 0 || regions.length === 0) return;
    fetchPrices(planBuyItems.map((i) => i.typeId)).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planBuyItems, regions.length]);

  async function loadData() {
    setLoading(true);
    setError(null);
    try { setTrackedRows(await getRestockRows()); }
    catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }

  async function loadMargin() {
    const v = await getRestockMargin().catch(() => 10);
    setMarginPct(v); setMarginInput(String(v));
  }

  async function handleMarginBlur() {
    const v = parseFloat(marginInput);
    if (!isNaN(v) && v >= 0 && v <= 100) {
      setMarginPct(v);
      await setRestockMargin(v).catch(() => {});
    } else {
      setMarginInput(String(marginPct));
    }
  }

  function handleCopyPlanPrices() {
    const headers = ["Item", "Qty", ...regions.map((r) => r.label), "Best"];
    const rows = planBuyItems.map(({ typeId, typeName, qty, unitVolume }) => {
      const freight   = unitVolume * effectiveFreightIskPerM3;
      const hubPrices = getPricesForType(typeId);
      const bestSell  = hubPrices.reduce<number | null>(
        (b, p) => p.bestSell !== null ? (b === null ? p.bestSell : Math.min(b, p.bestSell)) : b,
        null,
      );
      return [
        typeName,
        qty,
        ...regions.map((r) => {
          const sell = hubPrices.find((p) => p.regionId === r.regionId)?.bestSell;
          return sell != null ? sell + freight : null;
        }),
        bestSell != null ? bestSell + freight : null,
      ];
    });
    const tsv = buildTsv(headers, rows);
    copyText(tsv).then(() => {
      setPlanCopied(true);
      if (planCopyTimer.current) clearTimeout(planCopyTimer.current);
      planCopyTimer.current = setTimeout(() => setPlanCopied(false), 1500);
    }).catch(() => {});
  }

  function handleCopyColumn(regionId: number) {
    const region = regions.find((r) => r.regionId === regionId);
    if (!region) return;
    const rows = planBuyItems
      .map(({ typeId, typeName, qty, unitVolume }) => {
        const freight = unitVolume * effectiveFreightIskPerM3;
        const entry   = getPricesForType(typeId).find((p) => p.regionId === regionId);
        return entry?.bestSell != null
          ? [typeName, qty, entry.bestSell + freight] as [string, number, number]
          : null;
      })
      .filter((r): r is [string, number, number] => r !== null);
    if (rows.length === 0) return;
    const tsv = buildTsv(["Item", "Qty", `${region.label} ISK`], rows);
    copyText(tsv).then(() => {
      setColCopied(regionId);
      if (colCopyTimer.current) clearTimeout(colCopyTimer.current);
      colCopyTimer.current = setTimeout(() => setColCopied(null), 1500);
    }).catch(() => {});
  }

  function handleFreightCommit() {
    setEditingFreight(false);
    const v = parseFloat(freightInput);
    if (!isNaN(v) && v >= 0) {
      setPlanFreightIskPerM3(v === 0 ? undefined : v);
    }
  }

  async function handleSearch(type: TypeSummary) {
    setAnalysisItem(type);
    setFetchingItem(true);
    await fetchPrices([type.typeId]).catch(() => {});
    setFetchingItem(false);
  }

  async function handleTrack(item: TypeSummary, qty: number) {
    if (trackedRows.some((r) => r.typeId === item.typeId)) return;
    await saveRestockTarget(item.typeId, qty).catch(() => {});
    await loadData();
  }

  async function handleUntrack(typeId: number) {
    await deleteRestockTarget(typeId).catch(() => {});
    setTrackedRows((prev) => prev.filter((r) => r.typeId !== typeId));
  }

  function startEditQty(typeId: number, current: number) {
    setEditQty((p) => ({ ...p, [typeId]: String(current) }));
  }

  async function commitEditQty(typeId: number) {
    const raw = editQty[typeId];
    if (raw === undefined) return;
    const qty = parseInt(raw, 10);
    if (!isNaN(qty) && qty >= 1) {
      await saveRestockTarget(typeId, qty).catch(() => {});
      setTrackedRows((prev) => prev.map((r) =>
        r.typeId === typeId
          ? { ...r, targetQty: qty, deficit: Math.max(0, qty - r.currentSellQty) }
          : r,
      ));
    }
    setEditQty((p) => { const n = { ...p }; delete n[typeId]; return n; });
  }

  function toggleExpand(typeId: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(typeId) ? next.delete(typeId) : next.add(typeId);
      return next;
    });
  }

  function getBestSell(typeId: number) {
    const entries = getPricesForType(typeId).filter((p) => p.bestSell != null);
    if (!entries.length) return null;
    return entries.reduce((best, p) =>
      p.bestSell! > (best.bestSell ?? 0) ? p : best
    );
  }

  function getMarginPct(typeId: number): number | null {
    const entries = getPricesForType(typeId).filter((p) => p.bestSell && p.bestBuy);
    if (!entries.length) return null;
    const bestSellEntry = entries.reduce((a, b) => a.bestSell! > b.bestSell! ? a : b);
    const bestBuyEntry  = entries.reduce((a, b) => a.bestBuy!  > b.bestBuy!  ? a : b);
    const sell = bestSellEntry.bestSell!;
    const buy  = bestBuyEntry.bestBuy!;
    return sell > 0 ? ((sell - buy) / sell) * 100 : null;
  }

  if (loading) return <div className="mkt-state">Loading…</div>;
  if (error) return (
    <div className="mkt-state">
      <span style={{ color: "var(--red)" }}>Failed to load data</span>
      <span style={{ fontSize: 11, color: "var(--text-3)" }}>{error}</span>
      <button className="mkt-retry" onClick={loadData}>Retry</button>
    </div>
  );

  return (
    <div className="mkt">

      {/* ── Top bar ── */}
      <div className="mkt-bar">
        <div className="mkt-search">
          <TypePicker
            placeholder="Search to analyse or add to watchlist…"
            onSelect={handleSearch}
          />
        </div>
        <div className="mkt-margin-wrap">
          <label className="mkt-margin-label" htmlFor="mkt-margin">Min margin</label>
          <input
            id="mkt-margin"
            type="number"
            className="mkt-margin-input"
            value={marginInput}
            min={0} max={100} step={0.5}
            onChange={(e) => setMarginInput(e.target.value)}
            onBlur={handleMarginBlur}
            title="Minimum acceptable margin %. Rows below this threshold are highlighted as warnings."
          />
          <span className="mkt-margin-unit">%</span>
        </div>
        <button
          className="mkt-refresh-btn"
          onClick={loadData}
          title="Refresh market orders from ESI"
        >
          ↺{fetching ? " …" : ""}
        </button>
      </div>

      <div className="mkt-body">

        {/* ── Analysis card ── */}
        {analysisItem && (
          <div className="mkt-analysis-wrap">
            {fetchingItem && <div className="mkt-fetching">Fetching prices…</div>}
            <AnalysisCard
              item={analysisItem}
              isTracked={trackedRows.some((r) => r.typeId === analysisItem.typeId)}
              onTrack={handleTrack}
              onUntrack={handleUntrack}
              onDismiss={() => setAnalysisItem(null)}
            />
          </div>
        )}

        {/* ── Plan prices ── */}
        {planBuyItems.length > 0 && regions.length > 0 && (
          <div className="mkt-plan">
            <div className="mkt-section-title mkt-section-title-row">
              <span>
                Plan Prices
                <span className="mkt-count"> · {planBuyItems.length}</span>
              </span>
              <div className="mkt-plan-title-controls">
                {activePlan && (
                  <div className="mkt-freight-wrap" title="Freight cost in ISK per m³ — added to all buy prices">
                    <span className="mkt-freight-label">Freight</span>
                    {editingFreight ? (
                      <input
                        autoFocus
                        type="number"
                        className="mkt-freight-input"
                        value={freightInput}
                        min={0}
                        step={100}
                        onChange={(e) => setFreightInput(e.target.value)}
                        onBlur={handleFreightCommit}
                        onKeyDown={(e) => { if (e.key === "Enter") handleFreightCommit(); else if (e.key === "Escape") setEditingFreight(false); }}
                      />
                    ) : (
                      <button
                        className={`mkt-freight-chip${effectiveFreightIskPerM3 > 0 ? " active" : ""}`}
                        onClick={() => { setFreightInput(String(effectiveFreightIskPerM3)); setEditingFreight(true); }}
                      >
                        {effectiveFreightIskPerM3 > 0
                          ? `${(effectiveFreightIskPerM3 / 1000).toFixed(0)}k/m³`
                          : "0/m³"}
                      </button>
                    )}
                  </div>
                )}
                <button
                  className="mkt-export-btn"
                  onClick={handleCopyPlanPrices}
                  title="Copy plan prices as tab-separated text — paste into a spreadsheet"
                >
                  {planCopied ? "Copied!" : "Copy all"}
                </button>
              </div>
            </div>
            <p className="mkt-section-hint">
              Items your current plan needs to buy, with prices across tracked market hubs.
              {effectiveFreightIskPerM3 > 0 && <span className="mkt-freight-note"> Freight ({effectiveFreightIskPerM3.toLocaleString()} ISK/m³) included.</span>}
            </p>
            <div className="mkt-plan-scroll">
              <table className="mkt-plan-table">
                <thead>
                  <tr>
                    <th className="mkt-plan-th mkt-plan-th-name">Item</th>
                    <th className="mkt-plan-th mkt-plan-th-r" title="Units to purchase">Qty</th>
                    {regions.map((r) => (
                      <th key={r.id} className="mkt-plan-th mkt-plan-th-r mkt-plan-th-hub" title={r.label}>
                        <span className="mkt-plan-th-hub-label">{r.label}</span>
                        <button
                          className="mkt-col-copy-btn"
                          onClick={(e) => { e.stopPropagation(); handleCopyColumn(r.regionId); }}
                          title={`Copy ${r.label} buy list`}
                        >
                          {colCopied === r.regionId ? "✓" : "⎘"}
                        </button>
                      </th>
                    ))}
                    <th className="mkt-plan-th mkt-plan-th-r" title="Cheapest sell price across all tracked hubs">Best</th>
                  </tr>
                </thead>
                <tbody>
                  {planBuyItems.map(({ typeId, typeName, qty, unitVolume }) => {
                    const freight    = unitVolume * effectiveFreightIskPerM3;
                    const hubPrices  = getPricesForType(typeId);
                    const bestRaw    = hubPrices.reduce<number | null>(
                      (b, p) => p.bestSell !== null ? (b === null ? p.bestSell : Math.min(b, p.bestSell)) : b,
                      null,
                    );
                    const bestSell   = bestRaw != null ? bestRaw + freight : null;
                    const bestRegionId = hubPrices.find((p) => p.bestSell === bestRaw)?.regionId ?? null;
                    return (
                      <tr
                        key={typeId}
                        className="mkt-plan-row"
                        onClick={() => handleSearch({ typeId, typeName, categoryId: 0, volume: 0 })}
                        title="Click to analyse this item"
                      >
                        <td className="mkt-plan-td mkt-plan-name">{typeName}</td>
                        <td className="mkt-plan-td mkt-plan-r">{fmt.format(qty)}</td>
                        {regions.map((r) => {
                          const entry  = hubPrices.find((p) => p.regionId === r.regionId);
                          const adj    = entry?.bestSell != null ? entry.bestSell + freight : null;
                          const isBest = r.regionId === bestRegionId && bestSell !== null;
                          return (
                            <td key={r.id} className={`mkt-plan-td mkt-plan-r${isBest ? " mkt-plan-best" : ""}`}>
                              {adj != null ? fmtIsk(adj) : "—"}
                            </td>
                          );
                        })}
                        <td className="mkt-plan-td mkt-plan-r mkt-plan-best-col">
                          {bestSell != null ? fmtIsk(bestSell) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {planTotals && (
                  <tfoot>
                    <tr className="mkt-plan-total-row">
                      <td className="mkt-plan-td mkt-plan-total-label">Total cost</td>
                      <td className="mkt-plan-td mkt-plan-r mkt-plan-total">
                        {fmt.format(planTotals.totalQty)}
                      </td>
                      {regions.map((r) => {
                        const total   = planTotals.hubTotals.get(r.regionId) ?? null;
                        const partial = planTotals.hubPartial.get(r.regionId);
                        return (
                          <td key={r.id} className="mkt-plan-td mkt-plan-r mkt-plan-total"
                            title={partial ? "Some items have no price at this hub — total is partial" : undefined}>
                            {total ? `${partial ? "~" : ""}${fmtIsk(total)}` : "—"}
                          </td>
                        );
                      })}
                      <td className="mkt-plan-td mkt-plan-r mkt-plan-total mkt-plan-best-col"
                        title={planTotals.bestPartial ? "Some items have no price data — total is partial" : "Total if you buy everything at the cheapest available hub"}>
                        {planTotals.bestTotal > 0
                          ? `${planTotals.bestPartial ? "~" : ""}${fmtIsk(planTotals.bestTotal)}`
                          : "—"}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        )}

        {/* ── Watchlist ── */}
        <div className="mkt-watchlist">
          <div className="mkt-section-title">
            Watchlist
            {trackedRows.length > 0 && <span className="mkt-count"> · {trackedRows.length}</span>}
          </div>

          {trackedRows.length === 0 ? (
            <div className="mkt-empty">
              No items tracked yet. Search for an item above and click <strong>+ Track</strong>.
            </div>
          ) : (
            <div className="mkt-list">
              <div className="mkt-list-header">
                <span>Item</span>
                <span className="mkt-col-r" title="Active sell orders you currently have on market (last ESI sync)">On Market</span>
                <span className="mkt-col-r" title="Your target stock level. Click to edit.">Target</span>
                <span className="mkt-col-r" title="Units needed to reach target: Target − On Market">Deficit</span>
                <span className="mkt-col-r" title="Best sell order price across configured hubs">Best Sell</span>
                <span className="mkt-col-r" title="Profit margin: (sell − buy) ÷ sell across best hubs">Margin</span>
                <span />
              </div>

              {trackedRows.map((row) => {
                const bestEntry  = getBestSell(row.typeId);
                const margin     = getMarginPct(row.typeId);
                const lowMargin  = margin !== null && margin < marginPct;
                const hasDeficit = row.deficit > 0;
                const isEditing  = editQty[row.typeId] !== undefined;
                const isExpanded = expanded.has(row.typeId);
                const hubPrices  = getPricesForType(row.typeId);
                const bestRegion = regions.find((r) => r.regionId === bestEntry?.regionId);

                return (
                  <div key={row.typeId} className="mkt-list-item">
                    <div className={`mkt-row${hasDeficit ? " mkt-row-deficit" : ""}${lowMargin ? " mkt-row-warn" : ""}`}>
                      <button
                        className="mkt-row-name"
                        onClick={() => handleSearch({ typeId: row.typeId, typeName: row.typeName || `Type ${row.typeId}`, categoryId: 0, volume: 0 })}
                        title="Click to analyse this item"
                      >
                        {row.typeName || `Type ${row.typeId}`}
                      </button>

                      <span className="mkt-col-r mkt-qty">{fmt.format(row.currentSellQty)}</span>

                      <span className="mkt-col-r">
                        {isEditing ? (
                          <input
                            autoFocus
                            type="number"
                            className="mkt-qty-edit"
                            value={editQty[row.typeId]}
                            min={1}
                            onChange={(e) => setEditQty((p) => ({ ...p, [row.typeId]: e.target.value }))}
                            onBlur={() => commitEditQty(row.typeId)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitEditQty(row.typeId);
                              else if (e.key === "Escape") setEditQty((p) => { const n = { ...p }; delete n[row.typeId]; return n; });
                            }}
                          />
                        ) : (
                          <button
                            className="mkt-qty-btn"
                            onClick={() => startEditQty(row.typeId, row.targetQty)}
                            title="Click to edit target"
                          >
                            {fmt.format(row.targetQty)}
                          </button>
                        )}
                      </span>

                      <span className={`mkt-col-r mkt-deficit${hasDeficit ? " has-deficit" : ""}`}>
                        {hasDeficit ? `−${fmt.format(row.deficit)}` : "—"}
                      </span>

                      <span className="mkt-col-r" title={bestRegion ? `Best hub: ${bestRegion.label}` : undefined}>
                        {bestEntry?.bestSell ? fmtIsk(bestEntry.bestSell) : "—"}
                      </span>

                      <span className={`mkt-col-r mkt-margin${margin !== null ? (lowMargin ? " low" : " ok") : ""}`}>
                        {margin !== null ? `${margin.toFixed(1)}%` : "—"}
                      </span>

                      <span className="mkt-row-actions">
                        <button
                          className={`mkt-expand-btn${isExpanded ? " open" : ""}`}
                          onClick={() => toggleExpand(row.typeId)}
                          title={isExpanded ? "Collapse hub prices" : "Expand hub prices"}
                        >
                          ▾
                        </button>
                        <button
                          className="mkt-remove-btn"
                          onClick={() => handleUntrack(row.typeId)}
                          title="Remove from watchlist"
                        >
                          ×
                        </button>
                      </span>
                    </div>

                    {/* Inline hub expansion */}
                    {isExpanded && hubPrices.length > 0 && (
                      <div className="mkt-hub-expand">
                        {regions.map((region) => {
                          const entry = hubPrices.find((p) => p.regionId === region.regionId);
                          const s     = calcSpread(entry?.bestSell ?? null, entry?.bestBuy ?? null);
                          const best  = region.regionId === bestEntry?.regionId;
                          return (
                            <div key={region.id} className={`mkt-hub-expand-row${best ? " best" : ""}`}>
                              <span className="mkt-hub-expand-name">
                                {region.label}
                                {best && <span className="mkt-hub-dot" />}
                              </span>
                              <span className="mkt-hub-expand-buy">{fmtIsk(entry?.bestBuy ?? null)}</span>
                              <span className="mkt-hub-expand-sell">{fmtIsk(entry?.bestSell ?? null)}</span>
                              <span className={`mkt-hub-expand-spread${s !== null ? (s > 10 ? " high" : s > 3 ? " mid" : " low") : ""}`}>
                                {s !== null ? `${s.toFixed(1)}%` : "—"}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── System cost comparison ── */}
        <div className="mkt-systems">
          <div className="mkt-section-title">System Comparison</div>
          <p className="mkt-section-hint">
            Track solar systems to compare manufacturing cost indices and market prices across hubs.
            Green = cheap index, yellow = above 5%.
          </p>
          <SystemComparison />
        </div>

      </div>
    </div>
  );
}
