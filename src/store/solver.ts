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
  let missingJobCost = false;

  function visit(node: BuildNode) {
    const isBuildNode = node.kind.type === "manufacturing" || node.kind.type === "reaction" || node.kind.type === "invention";
    if (isBuildNode && node.jobCost === null) missingJobCost = true;
    for (const child of node.inputs) visit(child);
  }
  for (const root of roots) visit(root);

  if (missingJobCost) {
    warnings.push("Job costs are missing for some items. Set a structure profile with a solar system in Settings → Structure Profiles.");
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
      // Fire-and-forget: fetch market prices for every item in the plan.
      const typeIds = collectTypeIds(nodes);
      if (typeIds.length > 0) {
        useMarketStore.getState().fetchPrices(typeIds).catch(() => {/* non-fatal */});
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
