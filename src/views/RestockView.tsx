// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useRef, useState } from "react";
import { useMarketStore } from "../store/market";
import { usePlanStore } from "../store/plan";
import {
  getRestockRows, saveRestockTarget, deleteRestockTarget,
  getRestockMargin, setRestockMargin,
  getDefaultOverbuildPct, setDefaultOverbuildPct,
} from "../api";
import type { RestockRow } from "../api";
import { TypePicker } from "../components/common/TypePicker";
import type { TypeSummary } from "../api";
import { buildCsv, buildTsv, downloadCsv, copyText } from "../lib/export";
import { esiErrorMessage } from "../lib/format";
import "./RestockView.css";

const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const fmtPrice = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

export function RestockView() {
  const [rows, setRows]               = useState<RestockRow[]>([]);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [marginPct, setMarginPct]     = useState(10);
  const [marginInput, setMarginInput] = useState("10");
  const [hideLowMargin, setHideLowMargin] = useState(false);
  const [overbuildPct, setOverbuildPct]   = useState(0);
  const [overbuildInput, setOverbuildInput] = useState("0");

  // Pending add flow
  const [pendingItem, setPendingItem]   = useState<TypeSummary | null>(null);
  const [pendingQty, setPendingQty]     = useState("1");

  // Inline qty editing
  const [editQty, setEditQty]       = useState<Record<number, string>>({});
  const [copyLabel, setCopyLabel]   = useState<"deficit" | "done" | null>(null);
  const copyTimer                   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [addedToPlan, setAddedToPlan] = useState<number | null>(null);
  const addedTimer                    = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
    if (addedTimer.current) clearTimeout(addedTimer.current);
  }, []);

  const marketPrices  = useMarketStore((s) => s.prices);
  const fetchPrices   = useMarketStore((s) => s.fetchPrices);
  const fetching      = useMarketStore((s) => s.fetching);
  const addTarget     = usePlanStore((s) => s.addTarget);

  useEffect(() => {
    loadData();
    getRestockMargin().then((v) => {
      setMarginPct(v);
      setMarginInput(String(v));
    });
    getDefaultOverbuildPct().then((v) => {
      setOverbuildPct(v * 100);
      setOverbuildInput(String(v * 100));
    });
  }, []);

  // When rows change, fetch market prices for all type IDs.
  useEffect(() => {
    if (rows.length === 0) return;
    const ids = rows.map((r) => r.typeId);
    fetchPrices(ids).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const data = await getRestockRows();
      setRows(data);
    } catch (e) {
      setError(esiErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  function handleCopyDeficitList() {
    const deficitRows = rows.filter((r) => r.deficit > 0);
    if (deficitRows.length === 0) return;
    const tsv = buildTsv(
      ["Item", "Deficit", "Best Sell ISK"],
      deficitRows.map((r) => [
        r.typeName || `Type ${r.typeId}`,
        r.deficit,
        getLowestSellPrice(r.typeId) ?? null,
      ]),
    );
    copyText(tsv).then(() => {
      setCopyLabel("done");
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyLabel(null), 1500);
    }).catch(() => {});
  }

  function handleExportCsv() {
    const headers = ["Item", "Real Stock", "On Market", "Velocity (30d)", "Target", "Deficit", "Best Sell ISK", "Margin %"];
    const csvRows = rows.map((r) => {
      const sell   = getLowestSellPrice(r.typeId);
      const margin = getMarginPctFor(r.typeId);
      return [
        r.typeName || `Type ${r.typeId}`,
        r.realStockQty,
        r.onMarketQty,
        r.sellVelocity ?? null,
        r.targetQty,
        r.deficit > 0 ? r.deficit : null,
        sell ?? null,
        margin !== null ? parseFloat(margin.toFixed(2)) : null,
      ];
    });
    downloadCsv("restock-list.csv", buildCsv(headers, csvRows));
  }

  async function handleRefresh() {
    await loadData();
  }

  // Per-type (lowest sell, highest buy) across all regions, precomputed once
  // per marketPrices change instead of re-scanning all price entries per row
  // on every render. Sell uses the conservative (min) aggregate so restock
  // margin math doesn't overstate profit; buy uses the max (what you'd pay
  // to source). Not to be confused with MarketView's getBestSellEntry, which
  // takes the opposite (max) aggregate to find where to actually sell.
  const priceExtremesByType = useMemo(() => {
    const map = new Map<number, { lowestSell: number | null; highestBuy: number | null }>();
    for (const p of Object.values(marketPrices)) {
      const entry = map.get(p.typeId) ?? { lowestSell: null, highestBuy: null };
      if (p.bestSell != null) entry.lowestSell = entry.lowestSell === null ? p.bestSell : Math.min(entry.lowestSell, p.bestSell);
      if (p.bestBuy != null) entry.highestBuy = entry.highestBuy === null ? p.bestBuy : Math.max(entry.highestBuy, p.bestBuy);
      map.set(p.typeId, entry);
    }
    return map;
  }, [marketPrices]);

  function getLowestSellPrice(typeId: number): number | null {
    return priceExtremesByType.get(typeId)?.lowestSell ?? null;
  }

  function getBestBuy(typeId: number): number | null {
    return priceExtremesByType.get(typeId)?.highestBuy ?? null;
  }

  function getMarginPctFor(typeId: number): number | null {
    const sell = getLowestSellPrice(typeId);
    const buy  = getBestBuy(typeId);
    if (sell == null || buy == null || sell <= 0) return null;
    return ((sell - buy) / sell) * 100;
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

  async function handleOverbuildBlur() {
    const v = parseFloat(overbuildInput);
    if (!isNaN(v) && v >= 0) {
      setOverbuildPct(v);
      await setDefaultOverbuildPct(v / 100).catch(() => {});
      await loadData();
    } else {
      setOverbuildInput(String(overbuildPct));
    }
  }

  function handleTypeSelect(type: TypeSummary) {
    // Don't add duplicates
    if (rows.some((r) => r.typeId === type.typeId)) return;
    setPendingItem(type);
    setPendingQty("1");
  }

  async function handleConfirmAdd() {
    if (!pendingItem) return;
    const qty = parseInt(pendingQty, 10);
    if (isNaN(qty) || qty < 1) return;
    await saveRestockTarget(pendingItem.typeId, qty, null).catch(() => {});
    setPendingItem(null);
    await loadData();
  }

  function handleCancelAdd() {
    setPendingItem(null);
  }

  async function handleRemove(typeId: number) {
    await deleteRestockTarget(typeId).catch(() => {});
    setRows((prev) => prev.filter((r) => r.typeId !== typeId));
  }

  function startEditQty(typeId: number, currentQty: number) {
    setEditQty((prev) => ({ ...prev, [typeId]: String(currentQty) }));
  }

  async function commitEditQty(typeId: number) {
    const raw = editQty[typeId];
    if (raw === undefined) return;
    const qty = parseInt(raw, 10);
    if (!isNaN(qty) && qty >= 1) {
      const row = rows.find((r) => r.typeId === typeId);
      await saveRestockTarget(typeId, qty, row?.overbuildPct ?? null).catch(() => {});
      await loadData();
    }
    setEditQty((prev) => { const n = { ...prev }; delete n[typeId]; return n; });
  }

  async function commitOverbuildPct(typeId: number, raw: string) {
    const row = rows.find((r) => r.typeId === typeId);
    if (!row) return;
    const trimmed = raw.trim();
    const pct = trimmed === "" ? null : parseFloat(trimmed) / 100;
    if (pct !== null && (isNaN(pct) || pct < 0)) return;
    await saveRestockTarget(typeId, row.targetQty, pct).catch(() => {});
    await loadData();
  }

  async function handleUseSuggested(typeId: number) {
    const row = rows.find((r) => r.typeId === typeId);
    if (!row || row.suggestedTarget == null) return;
    await saveRestockTarget(typeId, row.suggestedTarget, row.overbuildPct ?? null).catch(() => {});
    await loadData();
  }

  function handleAddToPlan(typeId: number, deficit: number) {
    addTarget({
      typeId,
      quantity: deficit,
      structureProfileId: null,
      stockTargetTypeId: typeId,
    });
    setAddedToPlan(typeId);
    if (addedTimer.current) clearTimeout(addedTimer.current);
    addedTimer.current = setTimeout(() => setAddedToPlan(null), 1500);
  }

  if (loading) {
    return (
      <div className="rst">
        <div className="rst-state">Loading restock data…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rst">
        <div className="rst-state">
          <span style={{ color: "var(--red)" }}>Failed to load restock data</span>
          <span style={{ fontSize: 11, color: "var(--text-3)" }}>{error}</span>
          <button className="rst-btn-confirm" onClick={loadData}>Retry</button>
        </div>
      </div>
    );
  }

  const visibleRows = hideLowMargin
    ? rows.filter((row) => {
        const margin = getMarginPctFor(row.typeId);
        return margin === null || margin >= marginPct;
      })
    : rows;

  return (
    <div className="rst">
      <div className="rst-scroll">

        {/* ── Header ────────────────────────────────────────────────────── */}
        <div className="rst-header">
          <div className="rst-header-left">
            <span className="rst-title">Market Restock</span>
            <span className="rst-subtitle">Track items you want to keep listed on market</span>
          </div>
          <div className="rst-header-right">
            <div className="rst-margin-wrap">
              <label className="rst-margin-label" htmlFor="rst-margin">Min margin</label>
              <input
                id="rst-margin"
                type="number"
                className="rst-margin-input"
                value={marginInput}
                min={0}
                max={100}
                step={0.5}
                onChange={(e) => setMarginInput(e.target.value)}
                onBlur={handleMarginBlur}
                title="Minimum acceptable margin %. Rows below this threshold are highlighted as warnings. Margin = (sell − buy) ÷ sell."
              />
              <span className="rst-margin-unit">%</span>
            </div>
            <label className="rst-hide-low-margin">
              <input
                type="checkbox"
                checked={hideLowMargin}
                onChange={(e) => setHideLowMargin(e.target.checked)}
              />
              Hide below min
            </label>
            <div className="rst-margin-wrap">
              <label className="rst-margin-label" htmlFor="rst-overbuild">Default overbuild</label>
              <input
                id="rst-overbuild"
                type="number"
                className="rst-margin-input"
                value={overbuildInput}
                min={0}
                step={5}
                onChange={(e) => setOverbuildInput(e.target.value)}
                onBlur={handleOverbuildBlur}
                title="Extra buffer kept on top of each item's target, as a %. Applies to any row without its own per-item override."
              />
              <span className="rst-margin-unit">%</span>
            </div>
            {rows.length > 0 && (
              <div className="rst-export-group">
                <button
                  className="rst-export-btn"
                  onClick={handleCopyDeficitList}
                  disabled={!rows.some((r) => r.deficit > 0)}
                  title="Copy deficit items as tab-separated text — paste into a spreadsheet or chat"
                >
                  {copyLabel === "done" ? "Copied!" : "Copy deficits"}
                </button>
                <button
                  className="rst-export-btn"
                  onClick={handleExportCsv}
                  title="Download full restock list as a CSV file"
                >
                  Export CSV
                </button>
              </div>
            )}
            <button className="rst-refresh-btn" onClick={handleRefresh} title="Refresh market orders">
              ↺{fetching ? " …" : ""}
            </button>
          </div>
        </div>

        {/* ── Add item ──────────────────────────────────────────────────── */}
        <div className="rst-add-section">
          {pendingItem ? (
            <div className="rst-pending">
              <span className="rst-pending-name">{pendingItem.typeName}</span>
              <label className="rst-pending-label">Target qty:</label>
              <input
                autoFocus
                type="number"
                className="rst-pending-qty"
                value={pendingQty}
                min={1}
                onChange={(e) => setPendingQty(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleConfirmAdd(); else if (e.key === "Escape") handleCancelAdd(); }}
              />
              <button className="rst-btn-confirm" onClick={handleConfirmAdd}>Add</button>
              <button className="rst-btn-cancel" onClick={handleCancelAdd}>Cancel</button>
            </div>
          ) : (
            <div className="rst-add-row">
              <TypePicker
                placeholder="Add item to track…"
                onSelect={handleTypeSelect}
                clearOnSelect
              />
            </div>
          )}
        </div>

        {/* ── Item list ─────────────────────────────────────────────────── */}
        {rows.length === 0 ? (
          <div className="rst-empty">
            <p>No items tracked yet.</p>
            <p>Use the search above to add items you sell on the market.</p>
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="rst-empty">
            <p>All tracked items are below the minimum margin.</p>
            <p>Uncheck "Hide below min" to see them.</p>
          </div>
        ) : (
          <div className="rst-list">
            <div className="rst-list-header">
              <span>Item</span>
              <span className="rst-col-center" title="ESI assets + virtual hangar, summed across all your characters.">Real stock</span>
              <span className="rst-col-center" title="Active sell orders you currently have listed on market (from last ESI sync).">On market</span>
              <span className="rst-col-center" title="Units sold across all your characters in the last 30 days. Shows — if no character has re-authenticated to grant wallet access.">Velocity (30d)</span>
              <span className="rst-col-center" title="Your minimum stock level. When Real stock falls below this (plus overbuild), the row is flagged as a deficit. Click the number to edit.">Target</span>
              <span className="rst-col-center" title="Extra buffer kept on top of target, as a %. Blank uses the global default (Settings).">Overbuild %</span>
              <span className="rst-col-center" title="How many units you're short: Target × (1 + overbuild) − Real stock. Only shown when understocked.">Deficit</span>
              <span className="rst-col-right" title="Lowest sell order price across your configured market hubs. This is what buyers pay — your revenue per unit.">Best sell</span>
              <span className="rst-col-right" title="Profit margin: (sell − buy) ÷ sell. Below your minimum threshold the row is highlighted as a warning.">Margin</span>
              <span />
            </div>

            {visibleRows.map((row) => {
              const sell    = getLowestSellPrice(row.typeId);
              const margin  = getMarginPctFor(row.typeId);
              const lowMargin = margin !== null && margin < marginPct;
              const hasDeficit = row.deficit > 0;
              const isEditing = editQty[row.typeId] !== undefined;

              return (
                <div
                  key={row.typeId}
                  className={`rst-row${hasDeficit ? " rst-row-deficit" : ""}${lowMargin ? " rst-row-low-margin" : ""}`}
                >
                  <span className="rst-row-name" title={row.typeName}>{row.typeName || `Type ${row.typeId}`}</span>

                  <span className="rst-col-center rst-qty">{fmt.format(row.realStockQty)}</span>

                  <span className="rst-col-center rst-qty">{fmt.format(row.onMarketQty)}</span>

                  <span className="rst-col-center rst-qty">
                    {row.sellVelocity != null ? (
                      <>
                        {fmt.format(row.sellVelocity)}
                        {row.suggestedTarget != null && row.suggestedTarget !== row.targetQty && (
                          <button
                            className="rst-suggest-btn"
                            onClick={() => handleUseSuggested(row.typeId)}
                            title={`Use suggested target (${fmt.format(row.suggestedTarget)}, based on 30-day sales)`}
                          >
                            →{fmt.format(row.suggestedTarget)}
                          </button>
                        )}
                      </>
                    ) : (
                      <span title="No character has re-authenticated to grant wallet access yet — see Characters settings.">—</span>
                    )}
                  </span>

                  <span className="rst-col-center">
                    {isEditing ? (
                      <input
                        autoFocus
                        type="number"
                        className="rst-qty-edit"
                        value={editQty[row.typeId]}
                        min={1}
                        onChange={(e) => setEditQty((p) => ({ ...p, [row.typeId]: e.target.value }))}
                        onBlur={() => commitEditQty(row.typeId)}
                        onKeyDown={(e) => { if (e.key === "Enter") commitEditQty(row.typeId); else if (e.key === "Escape") { setEditQty((p) => { const n = {...p}; delete n[row.typeId]; return n; }); } }}
                      />
                    ) : (
                      <button
                        className="rst-qty-btn"
                        onClick={() => startEditQty(row.typeId, row.targetQty)}
                        title="Click to edit target"
                      >
                        {fmt.format(row.targetQty)}
                      </button>
                    )}
                  </span>

                  <span className="rst-col-center">
                    <input
                      type="number"
                      className="rst-overbuild-edit"
                      placeholder="default"
                      defaultValue={row.overbuildPct != null ? row.overbuildPct * 100 : ""}
                      min={0}
                      step={1}
                      onBlur={(e) => commitOverbuildPct(row.typeId, e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                    />
                  </span>

                  <span className={`rst-col-center rst-deficit${hasDeficit ? " has-deficit" : ""}`}>
                    {hasDeficit ? `−${fmt.format(row.deficit)}` : "—"}
                  </span>

                  <span className="rst-col-right rst-price">
                    {sell != null ? `${fmtPrice.format(sell)} ISK` : "—"}
                  </span>

                  <span className={`rst-col-right rst-margin${margin !== null ? (lowMargin ? " low" : " ok") : ""}`}>
                    {margin !== null ? `${margin.toFixed(1)}%` : "—"}
                  </span>

                  <span className="rst-col-actions">
                    {hasDeficit && (
                      <button
                        className="rst-add-plan-btn"
                        onClick={() => handleAddToPlan(row.typeId, row.deficit)}
                        title="Add this deficit to the active plan, live-linked to this restock policy — quantity recalculates at solve time."
                      >
                        {addedToPlan === row.typeId ? "Added" : "+ Plan"}
                      </button>
                    )}
                    <button
                      className="rst-remove-btn"
                      onClick={() => handleRemove(row.typeId)}
                      title="Remove from restock list"
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
    </div>
  );
}