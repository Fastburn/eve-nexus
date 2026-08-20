// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { create } from "zustand";
import { solveBuildPlan } from "../api";
import type { BuildNode, SolvePlanRequest } from "../api";
import { useMarketStore } from "./market";
import { useSettingsStore } from "./settings";

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

  const profiles = useSettingsStore.getState().structureProfiles;
  for (const [jobType, exampleName] of missingByJobType) {
    const matchingCount = profiles.filter((p) => p.jobType === jobType).length;
    const detail = matchingCount === 0
      ? `because no ${jobType} structure profile with a solar system is set. Add one in Settings → Structure Profiles.`
      : `because ${matchingCount} ${jobType} structure profiles exist and eve-nexus can't guess which one to use. Assign one to this build target with the profile dropdown in the sidebar.`;
    warnings.push(`Job cost is missing for "${exampleName}" (and possibly other items) ${detail}`);
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

// Bumped on every solve() call so a slower, superseded request can detect
// it's stale and drop its result instead of clobbering a newer one.
let solveGeneration = 0;

export const useSolverStore = create<SolverState>((set) => ({
  nodes: [],
  solving: false,
  error: null,
  warnings: [],

  solve: async (request) => {
    const generation = ++solveGeneration;
    set({ solving: true, error: null, warnings: [] });
    try {
      const nodes = await solveBuildPlan(request);
      if (generation !== solveGeneration) return; // a newer solve() superseded this one
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
      if (generation !== solveGeneration) return;
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