// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { create } from "zustand";
import { solveBuildPlan } from "../api";
import type { BuildNode, SolvePlanRequest } from "../api";
import { useMarketStore } from "./market";

// Collect every unique typeId from the solved node tree.
function collectTypeIds(roots: BuildNode[]): number[] {
  const ids = new Set<number>();
  function visit(node: BuildNode) {
    ids.add(node.typeId);
    for (const child of node.inputs) visit(child);
  }
  for (const root of roots) visit(root);
  return Array.from(ids);
}

// Check solved nodes for missing data and return human-readable warnings.
function detectWarnings(roots: BuildNode[]): string[] {
  const warnings: string[] = [];
  // Track which job type (Manufacturing/Reaction) is missing a profile, and
  // one example item name per job type, so the warning tells the user
  // exactly what to fix instead of a generic "some items" message. This
  // matters because an item's activity isn't always what it looks like —
  // e.g. R.A.M.- intermediate "Commodity"-category items are manufactured,
  // not reacted, even though reactions also produce Commodity-category
  // outputs, so the two activities need separate structure profiles.
  const missingByJobType = new Map<string, string>();

  function visit(node: BuildNode) {
    if (node.kind.type === "manufacturing" && node.jobCost === null) {
      if (!missingByJobType.has("Manufacturing")) missingByJobType.set("Manufacturing", node.typeName);
    } else if (node.kind.type === "reaction" && node.jobCost === null) {
      if (!missingByJobType.has("Reaction")) missingByJobType.set("Reaction", node.typeName);
    }
    for (const child of node.inputs) visit(child);
  }
  for (const root of roots) visit(root);

  for (const [jobType, exampleName] of missingByJobType) {
    warnings.push(
      `Job cost is missing for "${exampleName}" (and possibly other items) because no ${jobType} structure profile with a solar system is set. Add one in Settings → Structure Profiles.`
    );
  }

  return warnings;
}

interface SolverState {
  // ── Results ───────────────────────────────────────────────────────────────
  nodes: BuildNode[];

  // ── Status ────────────────────────────────────────────────────────────────
  solving: boolean;
  error: string | null;
  warnings: string[];

  // ── Actions ───────────────────────────────────────────────────────────────
  solve: (request: SolvePlanRequest) => Promise<void>;
  dismissError: () => void;
  dismissWarnings: () => void;
  clear: () => void;
}

export const useSolverStore = create<SolverState>((set) => ({
  nodes: [],
  solving: false,
  error: null,
  warnings: [],

  solve: async (request) => {
    set({ solving: true, error: null, warnings: [] });
    try {
      const nodes = await solveBuildPlan(request);
      const warnings = detectWarnings(nodes);
      set({ nodes, solving: false, warnings });
      // Fire-and-forget: fetch market prices and history for every item in the plan.
      const typeIds = collectTypeIds(nodes);
      if (typeIds.length > 0) {
        const market = useMarketStore.getState();
        market.fetchPrices(typeIds).catch(() => {/* non-fatal */});
        market.fetchHistory(typeIds).catch(() => {/* non-fatal */});
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message
        : typeof e === "string" ? e
        : (e as { message?: string })?.message ?? JSON.stringify(e);
      set({ solving: false, error: msg });
    }
  },

  dismissError: () => set({ error: null }),
  dismissWarnings: () => set({ warnings: [] }),

  clear: () => set({ nodes: [], error: null, warnings: [] }),
}));