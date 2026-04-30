import { useState, useMemo } from "react";
import { useSolverStore, useUiStore, useMarketStore, usePlanStore } from "../../store";
import { TypeIcon } from "../common";
import { computeNodeCosts } from "../../lib/buildCost";
import { buildCsv, buildTsv, downloadCsv, copyText } from "../../lib/export";
import { fmtIsk } from "../../lib/format";
import type { BuildNode } from "../../api";
import type { NodeCosts } from "../../lib/buildCost";
import "./GridView.css";

// ── Flatten tree → unique nodes ───────────────────────────────────────────────

function nodeGridKey(node: BuildNode): string {
  // Invention nodes share typeId with their manufacturing counterpart — keep them separate.
  return `${node.typeId}_${node.kind.type}`;
}

function flattenNodes(roots: BuildNode[]): BuildNode[] {
  const map = new Map<string, BuildNode>();

  function visit(node: BuildNode) {
    const key = nodeGridKey(node);
    if (map.has(key)) {
      // Aggregate quantities from duplicate occurrences (shared materials across targets).
      const ex = map.get(key)!;
      ex.quantityNeeded      += node.quantityNeeded;
      // quantityOnHand is actual inventory (pre-deduction); keep the first (highest) value.
      // Summing would double/triple-count since each occurrence sees a lower available balance.
      ex.quantityInProgress  += node.quantityInProgress;
      ex.quantityFromHangar  += node.quantityFromHangar;
      ex.quantityToHangar    += node.quantityToHangar;
      ex.quantityProduced    += node.quantityProduced;
      ex.runs                += node.runs;
      if (node.jobCost != null) {
        ex.jobCost = (ex.jobCost ?? 0) + node.jobCost;
      }
      // Recompute to_buy from aggregated totals.
      ex.quantityToBuy = Math.max(
        0,
        ex.quantityNeeded - ex.quantityOnHand - ex.quantityInProgress - ex.quantityFromHangar,
      );
    } else {
      map.set(key, { ...node, inputs: [] });
    }
    for (const child of node.inputs) visit(child);
  }

  for (const root of roots) visit(root);
  return Array.from(map.values());
}

// ── Enriched node (flat node + derived market data) ──────────────────────────

interface EnrichedNode extends BuildNode {
  bestSellPrice: number | null;
  /** Buy vs build cost comparison — null for buy nodes or when price data is missing. */
  bvbCosts: NodeCosts | null;
}

// ── Column definitions ────────────────────────────────────────────────────────

type SortKey =
  | "name"
  | "kind"
  | "runs"
  | "needed"
  | "produced"
  | "onHand"
  | "inJobs"
  | "toBuy"
  | "jobCost"
  | "sellPrice"
  | "bvb";

interface Col {
  key: SortKey;
  label: string;
  align: "left" | "right";
  tip: string;
}

const COLS: Col[] = [
  { key: "name",      label: "Item",       align: "left",  tip: "The item being produced or purchased." },
  { key: "kind",      label: "Action",     align: "left",  tip: "What to do with this item. Build/Reaction/Invention = run an industry job. Buy = purchase from market. Short = partially covered by stock, buy the rest. Have = fully covered, nothing to do. Hangar = pulled from virtual hangar." },
  { key: "runs",      label: "Runs",       align: "right", tip: "Number of industry job runs needed to produce the required quantity." },
  { key: "needed",    label: "Needed",     align: "right", tip: "Total quantity required by the plan after accounting for on-hand stock and active jobs." },
  { key: "produced",  label: "Produced",   align: "right", tip: "Total units output by the planned runs. May exceed Needed — surplus stays in your hangar." },
  { key: "onHand",    label: "On Hand",    align: "right", tip: "Quantity already in your assets (from last ESI sync). Reduces how much you need to build or buy." },
  { key: "inJobs",    label: "In Jobs",    align: "right", tip: "Quantity currently in active industry jobs (from last ESI sync). Counted toward fulfilling the plan." },
  { key: "toBuy",     label: "To Buy",     align: "right", tip: "Quantity to purchase from the market: Needed − On Hand − In Jobs." },
  { key: "jobCost",   label: "Job Cost",   align: "right", tip: "Estimated ISK installation fee: output value × system cost index × facility tax. Lower cost index systems (e.g. null-sec) dramatically reduce this." },
  { key: "sellPrice", label: "Est. Sell",  align: "right", tip: "Best sell order price across your configured market hubs. Sell your output here for maximum revenue." },
  { key: "bvb",       label: "Buy vs Build", align: "right", tip: "For items you are building: compares market buy cost vs full build-path cost (materials + job fees). Positive savings = keep building; negative = buying is cheaper." },
];

const KIND_LABEL: Record<string, string> = {
  manufacturing: "Build",
  reaction:      "Reaction",
  invention:     "Invention",
  buy:           "Buy",
  virtualHangar: "Hangar",
};

function shouldBuy(node: EnrichedNode): boolean {
  return node.bvbCosts !== null && node.bvbCosts.delta < 0;
}

function kindLabel(node: EnrichedNode): string {
  if (node.kind.type === "buy") {
    const covered = node.quantityOnHand + node.quantityInProgress + node.quantityFromHangar;
    if (node.quantityToBuy === 0 && covered > 0) return "Have";
    if (node.quantityToBuy > 0  && covered > 0) return "Short";
  }
  if (shouldBuy(node)) return "Buy";
  return KIND_LABEL[node.kind.type] ?? node.kind.type;
}

function kindClass(node: EnrichedNode): string {
  if (node.kind.type === "buy") {
    const covered = node.quantityOnHand + node.quantityInProgress + node.quantityFromHangar;
    if (node.quantityToBuy === 0 && covered > 0) return "gv-kind gv-kind-have";
    if (node.quantityToBuy > 0  && covered > 0) return "gv-kind gv-kind-short";
  }
  if (shouldBuy(node)) return "gv-kind gv-kind-buy";
  return `gv-kind gv-kind-${node.kind.type}`;
}

function kindTip(node: EnrichedNode): string {
  if (shouldBuy(node)) {
    const saved = Math.abs(node.bvbCosts!.delta);
    return `Buying is cheaper — saves ${saved.toLocaleString(undefined, { maximumFractionDigits: 0 })} ISK vs building. Purchase from market instead.`;
  }
  switch (node.kind.type) {
    case "manufacturing": return "Manufacturing job — install at a structure.";
    case "reaction":      return "Reaction job — runs in a Refinery.";
    case "invention":     return "Invention job — produces BPCs from T1 blueprints.";
    case "virtualHangar": return "Sourced from your virtual hangar (Settings).";
    case "buy": {
      const covered = node.quantityOnHand + node.quantityInProgress + node.quantityFromHangar;
      if (node.quantityToBuy === 0 && covered > 0) return "Fully covered by stock — nothing to buy.";
      if (node.quantityToBuy > 0  && covered > 0) return "Partially covered by stock — buy the shortfall.";
      return "No stock — purchase from market.";
    }
    default: return "";
  }
}

function getValue(node: EnrichedNode, key: SortKey): string | number {
  switch (key) {
    case "name":      return node.typeName;
    case "kind":      return node.kind.type;
    case "runs":      return node.runs;
    case "needed":    return node.quantityNeeded;
    case "produced":  return node.quantityProduced;
    case "onHand":    return node.quantityOnHand;
    case "inJobs":    return node.quantityInProgress;
    case "toBuy":     return node.quantityToBuy;
    case "jobCost":   return node.jobCost ?? 0;
    case "sellPrice": return node.bestSellPrice ?? 0;
    case "bvb":       return node.bvbCosts?.delta ?? 0;
  }
}

function fmt(n: number): string {
  return n > 0 ? n.toLocaleString() : "—";
}


// ── Component ─────────────────────────────────────────────────────────────────

export function GridView() {
  const nodes      = useSolverStore((s) => s.nodes);
  const solving    = useSolverStore((s) => s.solving);
  const selectNode = useUiStore((s) => s.selectNode);

  // Subscribe to prices so component re-renders when prices are updated.
  const marketPrices   = useMarketStore((s) => s.prices);
  const pricesFetching = useMarketStore((s) => s.fetching);

  const planName = usePlanStore((s) => s.activePlan?.name ?? "build-plan");

  const [sortKey, setSortKey]       = useState<SortKey>("kind");
  const [sortAsc, setSortAsc]       = useState(true);
  const [filter, setFilter]         = useState("");
  const [copyLabel, setCopyLabel]   = useState<"buy" | "done-buy" | null>(null);

  const flat = useMemo(() => flattenNodes(nodes), [nodes]);

  // Best sell price across all configured regions for a given typeId.
  const getBestSell = useMemo(() => (typeId: number): number | null => {
    let best: number | null = null;
    for (const entry of Object.values(marketPrices)) {
      if (entry.typeId === typeId && entry.bestSell !== null) {
        best = best === null ? entry.bestSell : Math.max(best, entry.bestSell);
      }
    }
    return best;
  }, [marketPrices]);

  // Buy vs Build costs, keyed by typeId, computed from the ORIGINAL tree
  // (flat nodes have inputs stripped so we must walk nodes before flattening).
  const bvbCostsMap = useMemo(() => {
    const map = new Map<number, NodeCosts | null>();
    function visit(node: BuildNode) {
      if (
        (node.kind.type === "manufacturing" || node.kind.type === "reaction") &&
        !map.has(node.typeId)
      ) {
        map.set(node.typeId, computeNodeCosts(node, getBestSell));
      }
      for (const input of node.inputs) visit(input);
    }
    for (const root of nodes) visit(root);
    return map;
  }, [nodes, getBestSell]);

  // Flat nodes enriched with market sell price and buy-vs-build costs.
  const enriched = useMemo<EnrichedNode[]>(
    () =>
      flat.map((n) => ({
        ...n,
        bestSellPrice: getBestSell(n.typeId),
        bvbCosts: bvbCostsMap.get(n.typeId) ?? null,
      })),
    [flat, getBestSell, bvbCostsMap],
  );

  // ── Profit summary ────────────────────────────────────────────────────────
  const profitSummary = useMemo(() => {
    // Revenue: sell price of everything we're producing (root nodes).
    const revenue = nodes.reduce((sum, n) => {
      const p = getBestSell(n.typeId);
      return p !== null ? sum + p * n.quantityProduced : sum;
    }, 0);

    // Material cost: market cost of every item marked Buy (raw inputs to purchase).
    // Blueprint items are excluded — BPO prices on the market don't reflect BPC costs.
    const matCost = flat
      .filter((n) => n.kind.type === "buy" && !n.typeName.toLowerCase().includes("blueprint"))
      .reduce((sum, n) => {
        const p = getBestSell(n.typeId);
        return p !== null ? sum + p * n.quantityToBuy : sum;
      }, 0);

    // Job cost: sum of all industry installation fees (already calculated by solver).
    const jobCost = flat.reduce((sum, n) => sum + (n.jobCost ?? 0), 0);

    const profit = revenue - matCost - jobCost;
    const margin = revenue > 0 ? (profit / revenue) * 100 : null;

    return { revenue, matCost, jobCost, profit, margin };
  }, [nodes, flat, getBestSell]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return enriched;
    return enriched.filter((n) => n.typeName.toLowerCase().includes(q));
  }, [enriched, filter]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const av = getValue(a, sortKey);
      const bv = getValue(b, sortKey);
      const cmp = typeof av === "string"
        ? av.localeCompare(bv as string)
        : (av as number) - (bv as number);
      return sortAsc ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortAsc]);

  function handleExportCsv() {
    const headers = ["Item", "Kind", "Runs", "Needed", "Produced", "On Hand", "In Jobs", "To Buy", "Job Cost ISK", "Est Sell ISK", "Buy vs Build"];
    const rows = sorted.map((n) => [
      n.typeName,
      kindLabel(n),
      n.runs > 0 ? n.runs : null,
      n.quantityNeeded,
      n.quantityProduced,
      n.quantityOnHand,
      n.quantityInProgress,
      n.quantityToBuy > 0 ? n.quantityToBuy : null,
      n.jobCost ?? null,
      n.bestSellPrice ?? null,
      n.bvbCosts !== null
        ? (n.bvbCosts.delta >= 0 ? `Build saves ${n.bvbCosts.delta.toFixed(0)}` : `Buy saves ${Math.abs(n.bvbCosts.delta).toFixed(0)}`)
        : null,
    ]);
    const csv = buildCsv(headers, rows);
    const safeName = planName.replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").toLowerCase();
    downloadCsv(`${safeName || "build-plan"}.csv`, csv);
  }

  function handleCopyBuyList() {
    const buyItems = sorted.filter((n) => n.quantityToBuy > 0);
    if (buyItems.length === 0) return;
    const tsv = buildTsv(
      ["Item", "Qty to Buy"],
      buyItems.map((n) => [n.typeName, n.quantityToBuy]),
    );
    copyText(tsv).then(() => {
      setCopyLabel("done-buy");
      setTimeout(() => setCopyLabel(null), 1500);
    }).catch(() => {});
  }

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortAsc((a) => !a);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  // ── Empty / solving states ────────────────────────────────────────────────
  if (solving) {
    return (
      <div className="gv-state">
        <span className="gv-spinner" />
        <span>Solving…</span>
      </div>
    );
  }

  if (flat.length === 0) {
    return (
      <div className="gv-state">
        <span>No build plan solved yet.</span>
        <span>Add targets in the sidebar and click Solve.</span>
      </div>
    );
  }

  const { revenue, matCost, jobCost, profit, margin } = profitSummary;
  const hasPrices = revenue > 0 || matCost > 0;

  return (
    <div className="gv">
      {/* Profit summary bar */}
      <div className="gv-profit-bar">
        <div className="gv-profit-stat">
          <span className="gv-profit-label">Revenue</span>
          <span className="gv-profit-val gv-profit-pos">{hasPrices ? fmtIsk(revenue) : "—"}</span>
        </div>
        <span className="gv-profit-sep">−</span>
        <div className="gv-profit-stat">
          <span className="gv-profit-label">Materials</span>
          <span className="gv-profit-val">{hasPrices ? fmtIsk(matCost) : "—"}</span>
        </div>
        <span className="gv-profit-sep">−</span>
        <div className="gv-profit-stat">
          <span className="gv-profit-label">Job Cost</span>
          <span className="gv-profit-val">{fmtIsk(jobCost)}</span>
        </div>
        <span className="gv-profit-sep">=</span>
        <div className="gv-profit-stat">
          <span className="gv-profit-label">Profit</span>
          <span className={`gv-profit-val ${hasPrices ? (profit >= 0 ? "gv-profit-pos" : "gv-profit-neg") : ""}`}>
            {hasPrices ? fmtIsk(profit) : "—"}
          </span>
        </div>
        {margin !== null && hasPrices && (
          <span
            className={`gv-profit-margin ${profit >= 0 ? "gv-profit-pos" : "gv-profit-neg"}`}
            title={`Profit margin: ${margin.toFixed(1)}% of revenue. Calculated as (Revenue − Materials − Job Cost) ÷ Revenue. Target >15% after broker fees and sales tax.`}
          >
            {margin.toFixed(1)}%
          </span>
        )}
        <span className="gv-profit-spacer" />
        {pricesFetching && <span className="gv-profit-fetching">Updating prices…</span>}
        {!hasPrices && !pricesFetching && (
          <span className="gv-profit-fetching">No market price data — check Market Hubs in Settings.</span>
        )}
      </div>

      {/* Filter bar */}
      <div className="gv-toolbar">
        <input
          className="gv-filter"
          type="search"
          placeholder="Filter items…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="gv-count">{sorted.length} item{sorted.length !== 1 ? "s" : ""}</span>
        <button
          className="gv-export-btn"
          onClick={handleCopyBuyList}
          title="Copy shopping list (items to buy) as tab-separated text — paste into a spreadsheet or chat"
          disabled={!sorted.some((n) => n.quantityToBuy > 0)}
        >
          {copyLabel === "done-buy" ? "Copied!" : "Copy buy list"}
        </button>
        <button
          className="gv-export-btn"
          onClick={handleExportCsv}
          title="Download the full grid as a CSV file"
        >
          Export CSV
        </button>
      </div>

      {/* Table */}
      <div className="gv-scroll">
        <table className="gv-table">
          <thead>
            <tr>
              {COLS.map((col) => (
                <th
                  key={col.key}
                  className={`gv-th gv-th-${col.align}${sortKey === col.key ? " gv-th-active" : ""}`}
                  onClick={() => handleSort(col.key)}
                  title={col.tip}
                >
                  {col.label}
                  {sortKey === col.key && (
                    <span className="gv-sort-arrow">{sortAsc ? " ↑" : " ↓"}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((node) => (
              <tr
                key={node.typeId}
                className="gv-row"
                onClick={() => selectNode(String(node.typeId))}
              >
                <td className="gv-td gv-td-name">
                  <div className="gv-name-wrap">
                    <TypeIcon typeId={node.typeId} variant="icon" size={32} displaySize={18} alt="" />
                    <span className="gv-name">{node.typeName}</span>
                  </div>
                </td>
                <td className="gv-td">
                  <span className={kindClass(node)} title={kindTip(node)}>
                    {kindLabel(node)}
                  </span>
                </td>
                <td className="gv-td gv-td-right">{node.runs > 0 ? fmt(node.runs) : "—"}</td>
                <td className="gv-td gv-td-right">{fmt(node.quantityNeeded)}</td>
                <td className="gv-td gv-td-right gv-highlight">{fmt(node.quantityProduced)}</td>
                <td className="gv-td gv-td-right gv-green">{fmt(node.quantityOnHand)}</td>
                <td className="gv-td gv-td-right gv-yellow">{fmt(node.quantityInProgress)}</td>
                <td className="gv-td gv-td-right gv-muted">{fmt(node.quantityToBuy)}</td>
                <td className="gv-td gv-td-right">{fmtIsk(node.jobCost)}</td>
                <td className="gv-td gv-td-right gv-sell-price">{fmtIsk(node.bestSellPrice)}</td>
                <td className="gv-td gv-td-right">
                  {node.bvbCosts !== null ? (
                    <span className={node.bvbCosts.delta >= 0 ? "gv-bvb-build" : "gv-bvb-buy"}>
                      {node.bvbCosts.delta >= 0
                        ? `Build saves ${fmtIsk(node.bvbCosts.delta)}`
                        : `Buy saves ${fmtIsk(Math.abs(node.bvbCosts.delta))}`}
                    </span>
                  ) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
