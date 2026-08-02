// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useMemo, useCallback, useRef } from "react";
import { useSolverStore, useUiStore, useMarketStore, usePlanStore, useSettingsStore } from "../../store";
import { TypeIcon, Select, blueprintIconVariant } from "../common";
import { computeNodeCosts } from "../../lib/buildCost";
import { buildCsv, buildTsv, downloadCsv, copyText } from "../../lib/export";
import { fmtIsk } from "../../lib/format";
import type { BuildNode, TypeId } from "../../api";
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
      // quantityOnHand is now capped per-occurrence to what that occurrence actually
      // consumed (backend never lets two occurrences double-spend the same stock), so
      // summing gives the true total consumed across all occurrences of this type.
      ex.quantityOnHand      += node.quantityOnHand;
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
  adjusted30d:   number | null;
  /** Buy vs build cost comparison — null for buy nodes or when price data is missing. */
  bvbCosts: NodeCosts | null;
}

// ── Category filter chips ─────────────────────────────────────────────────────

interface ChipDef {
  id: string;
  label: string;
  match: (n: BuildNode) => boolean;
}

const CHIP_DEFS: ChipDef[] = [
  { id: "minerals",   label: "Minerals",   match: (n) => n.groupId === 18 },
  { id: "pi",         label: "PI",         match: (n) => n.categoryId === 43 },
  { id: "reactions",  label: "Reactions",  match: (n) => n.kind.type === "reaction" },
  { id: "ships",      label: "Ships",      match: (n) => n.categoryId === 6 },
  { id: "modules",    label: "Modules",    match: (n) => n.categoryId === 7 },
  { id: "drones",     label: "Drones",     match: (n) => n.categoryId === 18 },
  { id: "charges",    label: "Charges",    match: (n) => n.categoryId === 8 },
  { id: "components", label: "Components", match: (n) => n.categoryId === 4 && n.groupId !== 18 },
];

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
  | "avg30d"
  | "buyVol"
  | "bestSrc"
  | "trend"
  | "decrypter"
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
  { key: "avg30d",    label: "30d Avg",    align: "right", tip: "EVE's 30-day adjusted average price. Useful baseline for comparison — if Est. Sell is far above this, prices may be elevated." },
  { key: "buyVol",    label: "Buy m³",     align: "right", tip: "Packaged volume of items to purchase (Qty to Buy × unit volume). Use this to plan freight capacity." },
  { key: "bestSrc",   label: "Best Source", align: "left",  tip: "Cheapest place to buy this item after applying your freight rate. Requires one hub flagged Local in Settings → Market Hubs, plus at least one other hub with a price for this item." },
  { key: "trend",     label: "5d Trend",    align: "right", tip: "Price trend over the last 5 days based on market history. Shows % change in daily average price." },
  { key: "decrypter", label: "Decrypter", align: "left", tip: "Decrypter applied to this invention job. Auto-picked to minimize cost unless overridden here — the Auto option shows what auto-pick would choose. Change persists immediately but requires a re-solve to affect this plan's numbers." },
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
    case "avg30d":    return node.adjusted30d ?? 0;
    case "buyVol":    return node.quantityToBuy > 0 ? node.quantityToBuy * node.unitVolume : 0;
    case "bestSrc":   return node.typeName;
    case "trend":     return 0; // computed per-render, not sortable
    case "decrypter": return node.kind.type === "invention" ? (node.kind.decrypter?.typeName ?? "") : "";
    case "bvb":       return node.bvbCosts?.delta ?? 0;
  }
}

function fmt(n: number): string {
  return n > 0 ? n.toLocaleString() : "—";
}

function fmtVol(m3: number): string {
  return m3 >= 1000 ? `${(m3 / 1000).toFixed(1)}k` : m3.toFixed(1);
}

function buyVolTip(qty: number, vol: number, freightRate: number): string | undefined {
  if (qty <= 0) return undefined;
  const m3 = qty * vol;
  return freightRate > 0
    ? `${m3.toFixed(1)} m³ — est. freight: ${fmtIsk(m3 * freightRate)} @ ${fmtIsk(freightRate)}/m³`
    : `${m3.toFixed(1)} m³ — set a freight rate in Settings to see cost`;
}


// ── Component ─────────────────────────────────────────────────────────────────

export function GridView() {
  const nodes      = useSolverStore((s) => s.nodes);
  const solving    = useSolverStore((s) => s.solving);
  const selectNode = useUiStore((s) => s.selectNode);

  // Subscribe to prices and history so component re-renders when updated.
  const marketPrices   = useMarketStore((s) => s.prices);
  const marketRegions  = useMarketStore((s) => s.regions);
  const marketHistory  = useMarketStore((s) => s.history);
  const pricesFetching = useMarketStore((s) => s.fetching);

  const planName          = usePlanStore((s) => s.activePlan?.name ?? "build-plan");
  const freightIskPerM3   = usePlanStore((s) => s.effectiveFreightIskPerM3);

  const decrypterSpecs    = useSettingsStore((s) => s.decrypterSpecs);
  const decrypterChoices  = useSettingsStore((s) => s.decrypterChoices);
  const setDecrypterChoice   = useSettingsStore((s) => s.setDecrypterChoice);
  const clearDecrypterChoice = useSettingsStore((s) => s.clearDecrypterChoice);

  const decrypterNames = useMemo(() => {
    const map = new Map<TypeId, string>();
    for (const spec of decrypterSpecs) map.set(spec.typeId, spec.name);
    return map;
  }, [decrypterSpecs]);

  const decrypterOverrideMap = useMemo(() => {
    const map = new Map<TypeId, TypeId>();
    for (const c of decrypterChoices) map.set(c.typeId, c.decrypterTypeId);
    return map;
  }, [decrypterChoices]);

  const decrypterOptions = useMemo(
    () => [
      { value: "", label: "Auto" },
      ...decrypterSpecs.map((s) => ({ value: String(s.typeId), label: s.name })),
    ],
    [decrypterSpecs],
  );

  const [sortKey, setSortKey]       = useState<SortKey>("kind");
  const [sortAsc, setSortAsc]       = useState(true);
  const [filter, setFilter]         = useState("");
  const [typeFilters, setTypeFilters] = useState<Set<string>>(new Set());
  const [copyLabel, setCopyLabel]   = useState<"buy" | "done-buy" | "done-assets" | null>(null);
  const copyLabelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flat = useMemo(() => flattenNodes(nodes), [nodes]);

  // Best sell price across all configured regions, keyed by typeId. Built once per price update.
  const bestSellMap = useMemo(() => {
    const map = new Map<number, number>();
    for (const entry of Object.values(marketPrices)) {
      if (entry.bestSell !== null) {
        const cur = map.get(entry.typeId);
        if (cur === undefined || entry.bestSell > cur) map.set(entry.typeId, entry.bestSell);
      }
    }
    return map;
  }, [marketPrices]);

  const getBestSell = useCallback(
    (typeId: number): number | null => bestSellMap.get(typeId) ?? null,
    [bestSellMap],
  );

  // Best source for buying: compares landed cost (sell + freight for non-local hubs).
  // Returns null when comparison isn't possible (no local hub flagged, or <2 hubs with prices).
  const getBestSource = useMemo(() => (
    typeId: number,
    unitVolume: number,
  ): { label: string; landedCost: number; isLocal: boolean; savings: number } | null => {
    if (!marketRegions.some((r) => r.isLocal)) return null;

    const options: { label: string; landedCost: number; isLocal: boolean }[] = [];
    for (const region of marketRegions) {
      const entry = marketPrices[`${region.regionId}:${typeId}`];
      if (!entry?.bestSell) continue;
      const freight = region.isLocal ? 0 : unitVolume * freightIskPerM3;
      options.push({ label: region.label, landedCost: entry.bestSell + freight, isLocal: region.isLocal });
    }
    if (options.length < 2) return null;

    options.sort((a, b) => a.landedCost - b.landedCost);
    return { ...options[0], savings: options[1].landedCost - options[0].landedCost };
  }, [marketPrices, marketRegions, freightIskPerM3]);

  // 5-day price trend: % change from the oldest available entry (up to 5 days ago)
  // to the most recent, across all regions (prefer highest volume).
  const getTrend = useMemo(() => (typeId: number): { pct: number; days: number } | null => {
    let best: { pct: number; days: number; vol: number } | null = null;
    for (const region of marketRegions) {
      const key = `${region.regionId}:${typeId}`;
      const entries = marketHistory[key];
      if (!entries || entries.length < 2) continue;
      // entries are newest-first; take up to 5 days
      const window = entries.slice(0, 5);
      const latest = window[0];
      const oldest = window[window.length - 1];
      if (oldest.average === 0) continue;
      const pct = ((latest.average - oldest.average) / oldest.average) * 100;
      const vol = window.reduce((s, e) => s + e.volume, 0);
      if (!best || vol > best.vol) {
        best = { pct, days: window.length, vol };
      }
    }
    return best ? { pct: best.pct, days: best.days } : null;
  }, [marketHistory, marketRegions]);

  // 30d adjusted average keyed by typeId — built once per price update.
  const adjusted30dMap = useMemo(() => {
    const map = new Map<number, number>();
    for (const entry of Object.values(marketPrices)) {
      if (entry.adjusted30d !== null && !map.has(entry.typeId)) {
        map.set(entry.typeId, entry.adjusted30d);
      }
    }
    return map;
  }, [marketPrices]);

  // Tooltip for the 30d avg cell: shows per-hub sell prices vs the average.
  const get30dTooltip = useMemo(() => (typeId: number, avg: number | null): string => {
    if (avg === null) return "No 30d average data available.";
    const lines = [`30d Avg: ${fmtIsk(avg)}`];
    for (const region of marketRegions) {
      const entry = marketPrices[`${region.regionId}:${typeId}`];
      if (entry?.bestSell !== null && entry?.bestSell !== undefined) {
        const diff = ((entry.bestSell - avg) / avg) * 100;
        const sign = diff >= 0 ? "+" : "";
        lines.push(`${region.label}: ${fmtIsk(entry.bestSell)} (${sign}${diff.toFixed(1)}%)`);
      }
    }
    return lines.join("\n");
  }, [marketPrices, marketRegions]);

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
        adjusted30d:   adjusted30dMap.get(n.typeId) ?? null,
        bvbCosts:      bvbCostsMap.get(n.typeId) ?? null,
      })),
    [flat, getBestSell, adjusted30dMap, bvbCostsMap],
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

    // Total m³ of items to purchase (buy nodes with quantity > 0).
    const buyVolume = flat
      .filter((n) => n.quantityToBuy > 0)
      .reduce((sum, n) => sum + n.quantityToBuy * n.unitVolume, 0);

    return { revenue, matCost, jobCost, profit, margin, buyVolume };
  }, [nodes, flat, getBestSell]);

  // Only show chips that have at least one matching item in the current plan.
  const availableChips = useMemo(
    () => CHIP_DEFS.filter((chip) => enriched.some(chip.match)),
    [enriched],
  );

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const nameOk = (n: EnrichedNode) => !q || n.typeName.toLowerCase().includes(q);
    const typeOk = (n: EnrichedNode) =>
      typeFilters.size === 0 || CHIP_DEFS.some((c) => typeFilters.has(c.id) && c.match(n));
    return enriched.filter((n) => nameOk(n) && typeOk(n));
  }, [enriched, filter, typeFilters]);

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

  // Hide optional columns entirely when nothing in the current plan has data for them,
  // so plans without invention/BvB/market data don't drag in empty columns.
  const hiddenCols = useMemo(() => {
    const hidden = new Set<SortKey>();
    if (!sorted.some((n) => n.kind.type === "invention")) {
      hidden.add("decrypter");
    }
    if (!sorted.some((n) => n.bvbCosts !== null)) hidden.add("bvb");
    if (!sorted.some((n) => n.quantityToBuy > 0 && getBestSource(n.typeId, n.unitVolume) !== null)) {
      hidden.add("bestSrc");
    }
    if (!sorted.some((n) => getTrend(n.typeId) !== null)) hidden.add("trend");
    return hidden;
  }, [sorted, getBestSource, getTrend]);

  const visibleCols = useMemo(
    () => COLS.filter((col) => !hiddenCols.has(col.key)),
    [hiddenCols],
  );

  function handleExportCsv() {
    const headers = ["Item", "Kind", "Runs", "Needed", "Produced", "On Hand", "In Jobs", "To Buy", "Job Cost ISK", "Est Sell ISK", "30d Avg ISK", "Buy m3", "Decrypter", "Best Decrypter", "Buy vs Build"];
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
      n.adjusted30d ?? null,
      n.quantityToBuy > 0 ? n.quantityToBuy * n.unitVolume : null,
      n.kind.type === "invention" ? (n.kind.decrypter?.typeName ?? "None") : null,
      n.kind.type === "invention"
        ? (n.kind.bestDecrypterTypeId !== null ? decrypterNames.get(n.kind.bestDecrypterTypeId) ?? null : "None")
        : null,
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
      if (copyLabelTimer.current) clearTimeout(copyLabelTimer.current);
      copyLabelTimer.current = setTimeout(() => setCopyLabel(null), 1500);
    }).catch(() => {});
  }

  function handleCopyAssetsList() {
    const ownedItems = sorted.filter((n) => n.quantityOnHand + n.quantityFromHangar > 0);
    if (ownedItems.length === 0) return;
    const tsv = buildTsv(
      ["Item", "Qty Already Owned"],
      ownedItems.map((n) => [n.typeName, n.quantityOnHand + n.quantityFromHangar]),
    );
    copyText(tsv).then(() => {
      setCopyLabel("done-assets");
      if (copyLabelTimer.current) clearTimeout(copyLabelTimer.current);
      copyLabelTimer.current = setTimeout(() => setCopyLabel(null), 1500);
    }).catch(() => {});
  }

  function handleToggleChip(id: string) {
    setTypeFilters((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
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

  const { revenue, matCost, jobCost, profit, margin, buyVolume } = profitSummary;
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
        {buyVolume > 0 && (
          <div className="gv-profit-stat gv-profit-stat-sep" title="Total packaged volume of all items to purchase. Use this to estimate freight capacity needed.">
            <span className="gv-profit-label">Buy Vol.</span>
            <span className="gv-profit-val">{fmtVol(buyVolume)} m³</span>
          </div>
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
        {availableChips.length > 0 && (
          <div className="gv-chips">
            {availableChips.map((chip) => (
              <button
                key={chip.id}
                className={`gv-chip${typeFilters.has(chip.id) ? " gv-chip-active" : ""}`}
                onClick={() => handleToggleChip(chip.id)}
                title={`Filter to ${chip.label} only`}
              >
                {chip.label}
              </button>
            ))}
          </div>
        )}
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
          onClick={handleCopyAssetsList}
          title="Copy items already owned (assets + virtual hangar) as tab-separated text — what to pull instead of buy"
          disabled={!sorted.some((n) => n.quantityOnHand + n.quantityFromHangar > 0)}
        >
          {copyLabel === "done-assets" ? "Copied!" : "Copy assets list"}
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
              {visibleCols.map((col) => (
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
                key={`${node.typeId}_${node.kind.type}`}
                className="gv-row"
                onClick={() => selectNode(String(node.typeId))}
              >
                <td className="gv-td gv-td-name">
                  <div className="gv-name-wrap">
                    <TypeIcon typeId={node.typeId} variant={blueprintIconVariant(node)} size={32} displaySize={16} alt="" />
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
                <td className="gv-td gv-td-right gv-muted" title={get30dTooltip(node.typeId, node.adjusted30d)}>{fmtIsk(node.adjusted30d)}</td>
                <td
                  className="gv-td gv-td-right gv-muted"
                  title={buyVolTip(node.quantityToBuy, node.unitVolume, freightIskPerM3)}
                >
                  {node.quantityToBuy > 0 ? fmtVol(node.quantityToBuy * node.unitVolume) : "—"}
                </td>
                {!hiddenCols.has("bestSrc") && (
                  <td className="gv-td">
                    {(() => {
                      if (node.quantityToBuy === 0) return <span className="gv-muted">—</span>;
                      const src = getBestSource(node.typeId, node.unitVolume);
                      if (!src) return <span className="gv-muted">—</span>;
                      return (
                        <span
                          className={src.isLocal ? "gv-src-local" : "gv-src-import"}
                          title={`Landed cost: ${fmtIsk(src.landedCost)}/unit — saves ${fmtIsk(src.savings)} vs next option${!src.isLocal ? ` (includes ${fmtIsk(node.unitVolume * freightIskPerM3)}/unit freight)` : ""}`}
                        >
                          {src.label}
                          {src.savings > 0 && <span className="gv-src-saving"> −{fmtIsk(src.savings)}</span>}
                        </span>
                      );
                    })()}
                  </td>
                )}
                {!hiddenCols.has("trend") && (
                  <td className="gv-td gv-td-right">
                    {(() => {
                      const t = getTrend(node.typeId);
                      if (!t) return <span className="gv-muted">—</span>;
                      const up = t.pct >= 0;
                      const abs = Math.abs(t.pct).toFixed(1);
                      return (
                        <span
                          className={up ? "gv-trend-up" : "gv-trend-down"}
                          title={`${up ? "+" : ""}${t.pct.toFixed(2)}% over ${t.days} days`}
                        >
                          {up ? "↑" : "↓"} {abs}%
                        </span>
                      );
                    })()}
                  </td>
                )}
                {!hiddenCols.has("decrypter") && (
                  <td className="gv-td gv-td-decrypter" onClick={(e) => e.stopPropagation()}>
                    {node.kind.type === "invention" ? (
                      <Select
                        className="gv-decrypter-select"
                        value={String(decrypterOverrideMap.get(node.typeId) ?? "")}
                        onChange={(val) => {
                          if (val === "") clearDecrypterChoice(node.typeId);
                          else setDecrypterChoice(node.typeId, Number(val));
                        }}
                        options={[
                          {
                            value: "",
                            label: `Auto (${
                              node.kind.bestDecrypterTypeId !== null
                                ? decrypterNames.get(node.kind.bestDecrypterTypeId) ?? "—"
                                : "None"
                            })`,
                          },
                          ...decrypterOptions.slice(1),
                        ]}
                        title={
                          (node.kind.decrypter
                            ? `${node.kind.isOverridden ? "Overridden" : "Auto-picked"}: ${node.kind.decrypter.typeName} — saves ${fmtIsk(node.kind.iskSavedVsNoDecrypter)} vs no decrypter.`
                            : "No decrypter applied — auto-pick determined it wasn't worth the added cost.") +
                          " Change re-solves are not automatic — click Solve again to apply."
                        }
                      />
                    ) : (
                      <span className="gv-muted">—</span>
                    )}
                  </td>
                )}
                {!hiddenCols.has("bvb") && (
                  <td className="gv-td gv-td-right">
                    {node.bvbCosts !== null ? (
                      <span className={node.bvbCosts.delta >= 0 ? "gv-bvb-build" : "gv-bvb-buy"}>
                        {node.bvbCosts.delta >= 0
                          ? `Build saves ${fmtIsk(node.bvbCosts.delta)}`
                          : `Buy saves ${fmtIsk(Math.abs(node.bvbCosts.delta))}`}
                      </span>
                    ) : "—"}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}