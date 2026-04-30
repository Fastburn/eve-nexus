import { useEffect, useRef, useState } from "react";
import { useMarketStore } from "../store/market";
import {
  getRestockRows, saveRestockTarget, deleteRestockTarget,
  getRestockMargin, setRestockMargin,
} from "../api";
import type { RestockRow } from "../api";
import { TypePicker } from "../components/common/TypePicker";
import type { TypeSummary } from "../api";
import { buildCsv, buildTsv, downloadCsv, copyText } from "../lib/export";
import "./RestockView.css";

const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const fmtPrice = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

export function RestockView() {
  const [rows, setRows]               = useState<RestockRow[]>([]);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [marginPct, setMarginPct]     = useState(10);
  const [marginInput, setMarginInput] = useState("10");

  // Pending add flow
  const [pendingItem, setPendingItem]   = useState<TypeSummary | null>(null);
  const [pendingQty, setPendingQty]     = useState("1");

  // Inline qty editing
  const [editQty, setEditQty]       = useState<Record<number, string>>({});
  const [copyLabel, setCopyLabel]   = useState<"deficit" | "done" | null>(null);
  const copyTimer                   = useRef<ReturnType<typeof setTimeout> | null>(null);

  const marketPrices  = useMarketStore((s) => s.prices);
  const fetchPrices   = useMarketStore((s) => s.fetchPrices);
  const fetching      = useMarketStore((s) => s.fetching);

  useEffect(() => {
    loadData();
    getRestockMargin().then((v) => {
      setMarginPct(v);
      setMarginInput(String(v));
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
      setError(String(e));
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
        getBestSell(r.typeId) ?? null,
      ]),
    );
    copyText(tsv).then(() => {
      setCopyLabel("done");
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyLabel(null), 1500);
    }).catch(() => {});
  }

  function handleExportCsv() {
    const headers = ["Item", "On Market", "Target", "Deficit", "Best Sell ISK", "Margin %"];
    const csvRows = rows.map((r) => {
      const sell   = getBestSell(r.typeId);
      const margin = getMarginPctFor(r.typeId);
      return [
        r.typeName || `Type ${r.typeId}`,
        r.currentSellQty,
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

  // Best sell = min across all regions (what a buyer pays — i.e. what you earn)
  function getBestSell(typeId: number): number | null {
    const entries = Object.values(marketPrices).filter((p) => p.typeId === typeId && p.bestSell != null);
    if (entries.length === 0) return null;
    return Math.min(...entries.map((p) => p.bestSell!));
  }

  // Best buy = max across all regions (highest buy order — what you'd pay to source)
  function getBestBuy(typeId: number): number | null {
    const entries = Object.values(marketPrices).filter((p) => p.typeId === typeId && p.bestBuy != null);
    if (entries.length === 0) return null;
    return Math.max(...entries.map((p) => p.bestBuy!));
  }

  function getMarginPctFor(typeId: number): number | null {
    const sell = getBestSell(typeId);
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
    await saveRestockTarget(pendingItem.typeId, qty).catch(() => {});
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
      await saveRestockTarget(typeId, qty).catch(() => {});
      setRows((prev) => prev.map((r) =>
        r.typeId === typeId ? { ...r, targetQty: qty, deficit: Math.max(0, qty - r.currentSellQty) } : r
      ));
    }
    setEditQty((prev) => { const n = { ...prev }; delete n[typeId]; return n; });
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
        ) : (
          <div className="rst-list">
            <div className="rst-list-header">
              <span>Item</span>
              <span className="rst-col-center" title="Active sell orders you currently have listed on market (from last ESI sync).">On market</span>
              <span className="rst-col-center" title="Your minimum stock level. When On market falls below this, the row is flagged as a deficit. Click the number to edit.">Target</span>
              <span className="rst-col-center" title="How many units you're short: Target − On market. Only shown when understocked.">Deficit</span>
              <span className="rst-col-right" title="Lowest sell order price across your configured market hubs. This is what buyers pay — your revenue per unit.">Best sell</span>
              <span className="rst-col-right" title="Profit margin: (sell − buy) ÷ sell. Below your minimum threshold the row is highlighted as a warning.">Margin</span>
              <span />
            </div>

            {rows.map((row) => {
              const sell    = getBestSell(row.typeId);
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

                  <span className="rst-col-center rst-qty">{fmt.format(row.currentSellQty)}</span>

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
