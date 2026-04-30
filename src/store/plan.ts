import { create } from "zustand";
import {
  listPlans,
  getPlan,
  savePlan,
  deletePlan,
  getDefaultOverproductionMultiplier,
  setDefaultOverproductionMultiplier,
  getDefaultFreightIskPerM3,
  setDefaultFreightIskPerM3,
} from "../api";
import type { BuildTarget, PlanSummary, ProductionPlan, TypeId } from "../api";

interface PlanState {
  // ── Plan library ──────────────────────────────────────────────────────────
  plans: PlanSummary[];

  // ── Active working plan ───────────────────────────────────────────────────
  /** Full plan loaded from DB, or null for an unsaved session. */
  activePlan: ProductionPlan | null;
  /** The targets currently being edited — may differ from activePlan.targets. */
  targets: BuildTarget[];
  /** True when targets differ from the last saved state. */
  isDirty: boolean;

  // ── Global defaults (loaded once on init) ─────────────────────────────────
  globalMultiplier: number;
  globalFreightIskPerM3: number;

  // ── Effective values (plan override ?? global default) ────────────────────
  /** Effective overproduction multiplier for the active plan. */
  effectiveMultiplier: number;
  /** Effective freight cost ISK/m³ for the active plan. */
  effectiveFreightIskPerM3: number;

  // ── Loading states ────────────────────────────────────────────────────────
  loading: boolean;
  error: string | null;

  // ── Actions ───────────────────────────────────────────────────────────────
  fetchPlans: () => Promise<void>;
  loadGlobalDefaults: () => Promise<void>;
  openPlan: (id: string) => Promise<void>;
  newPlan: () => Promise<string>;

  /** Persist the active plan (creates if new, updates if existing). */
  saveCurrent: (name: string) => Promise<void>;
  /** Rename any plan by ID without touching its targets. */
  renamePlan: (id: string, name: string) => Promise<void>;
  deletePlan: (id: string) => Promise<void>;

  addTarget: (target: BuildTarget) => void;
  removeTarget: (typeId: TypeId) => void;
  updateTarget: (typeId: TypeId, patch: Partial<BuildTarget>) => void;
  clearTargets: () => void;

  /** Set per-plan overproduction multiplier (saves plan immediately). */
  setPlanMultiplier: (value: number | undefined) => Promise<void>;
  /** Set per-plan freight rate (saves plan immediately). */
  setPlanFreightIskPerM3: (value: number | undefined) => Promise<void>;
  /** Update and persist global default multiplier. */
  saveGlobalMultiplier: (value: number) => Promise<void>;
  /** Update and persist global default freight rate. */
  saveGlobalFreightIskPerM3: (value: number) => Promise<void>;
}

function nowIso() {
  return new Date().toISOString();
}

function randomId() {
  return crypto.randomUUID();
}

function computeEffective(plan: ProductionPlan | null, globalMultiplier: number, globalFreightIskPerM3: number) {
  return {
    effectiveMultiplier: plan?.overproductionMultiplier ?? globalMultiplier,
    effectiveFreightIskPerM3: plan?.freightIskPerM3 ?? globalFreightIskPerM3,
  };
}

export const usePlanStore = create<PlanState>((set, get) => ({
  plans: [],
  activePlan: null,
  targets: [],
  isDirty: false,
  globalMultiplier: 1.0,
  globalFreightIskPerM3: 0.0,
  effectiveMultiplier: 1.0,
  effectiveFreightIskPerM3: 0.0,
  loading: false,
  error: null,

  loadGlobalDefaults: async () => {
    const [globalMultiplier, globalFreightIskPerM3] = await Promise.all([
      getDefaultOverproductionMultiplier(),
      getDefaultFreightIskPerM3(),
    ]);
    const { activePlan } = get();
    set({
      globalMultiplier,
      globalFreightIskPerM3,
      ...computeEffective(activePlan, globalMultiplier, globalFreightIskPerM3),
    });
  },

  fetchPlans: async () => {
    set({ loading: true, error: null });
    try {
      set({ plans: await listPlans(), loading: false });
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },

  openPlan: async (id) => {
    set({ loading: true, error: null });
    try {
      const plan = await getPlan(id);
      if (plan) {
        const { globalMultiplier, globalFreightIskPerM3 } = get();
        set({
          activePlan: plan,
          targets: plan.targets,
          isDirty: false,
          ...computeEffective(plan, globalMultiplier, globalFreightIskPerM3),
        });
      }
      set({ loading: false });
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },

  newPlan: async () => {
    const now = nowIso();
    const plan: ProductionPlan = {
      id: randomId(),
      name: "New Plan",
      targets: [],
      createdAt: now,
      updatedAt: now,
    };
    await savePlan(plan);
    const { globalMultiplier, globalFreightIskPerM3 } = get();
    set({
      activePlan: plan,
      targets: [],
      isDirty: false,
      plans: await listPlans(),
      ...computeEffective(plan, globalMultiplier, globalFreightIskPerM3),
    });
    return plan.id;
  },

  saveCurrent: async (name) => {
    const { activePlan, targets } = get();
    const now = nowIso();
    const plan: ProductionPlan = {
      id: activePlan?.id ?? randomId(),
      name,
      targets,
      createdAt: activePlan?.createdAt ?? now,
      updatedAt: now,
      overproductionMultiplier: activePlan?.overproductionMultiplier,
      freightIskPerM3: activePlan?.freightIskPerM3,
    };
    await savePlan(plan);
    set({ activePlan: plan, isDirty: false });
    // Refresh summary list so the sidebar stays current.
    set({ plans: await listPlans() });
  },

  renamePlan: async (id, name) => {
    const { plans, activePlan, targets } = get();
    const summary = plans.find((p) => p.id === id);
    if (!summary) return;
    const now = nowIso();
    // Load existing plan data to preserve targets, then overwrite name.
    const existing = await getPlan(id);
    if (!existing) return;
    const updated = { ...existing, name, updatedAt: now };
    await savePlan(updated);
    set((s) => ({
      plans: s.plans.map((p) => p.id === id ? { ...p, name, updatedAt: now } : p),
      activePlan: activePlan?.id === id ? { ...activePlan, name, updatedAt: now } : s.activePlan,
    }));
    void targets; // targets unchanged
  },

  deletePlan: async (id) => {
    await deletePlan(id);
    const { activePlan } = get();
    if (activePlan?.id === id) {
      set({ activePlan: null, targets: [], isDirty: false });
    }
    set({ plans: await listPlans() });
  },

  addTarget: (target) => {
    set((s) => {
      // If the type is already in the list, merge quantities.
      const existing = s.targets.findIndex((t) => t.typeId === target.typeId);
      if (existing >= 0) {
        const updated = [...s.targets];
        updated[existing] = {
          ...updated[existing],
          quantity: updated[existing].quantity + target.quantity,
        };
        return { targets: updated, isDirty: true };
      }
      return { targets: [...s.targets, target], isDirty: true };
    });
  },

  removeTarget: (typeId) => {
    set((s) => ({
      targets: s.targets.filter((t) => t.typeId !== typeId),
      isDirty: true,
    }));
  },

  updateTarget: (typeId, patch) => {
    set((s) => ({
      targets: s.targets.map((t) =>
        t.typeId === typeId ? { ...t, ...patch } : t,
      ),
      isDirty: true,
    }));
  },

  clearTargets: () => {
    set({ targets: [], isDirty: true });
  },

  setPlanMultiplier: async (value) => {
    const { activePlan, globalMultiplier, globalFreightIskPerM3 } = get();
    if (!activePlan) return;
    const updated = { ...activePlan, overproductionMultiplier: value, updatedAt: nowIso() };
    await savePlan(updated);
    set({
      activePlan: updated,
      ...computeEffective(updated, globalMultiplier, globalFreightIskPerM3),
    });
  },

  setPlanFreightIskPerM3: async (value) => {
    const { activePlan, globalMultiplier, globalFreightIskPerM3 } = get();
    if (!activePlan) return;
    const updated = { ...activePlan, freightIskPerM3: value, updatedAt: nowIso() };
    await savePlan(updated);
    set({
      activePlan: updated,
      ...computeEffective(updated, globalMultiplier, globalFreightIskPerM3),
    });
  },

  saveGlobalMultiplier: async (value) => {
    await setDefaultOverproductionMultiplier(value);
    const { activePlan, globalFreightIskPerM3 } = get();
    set({
      globalMultiplier: value,
      ...computeEffective(activePlan, value, globalFreightIskPerM3),
    });
  },

  saveGlobalFreightIskPerM3: async (value) => {
    await setDefaultFreightIskPerM3(value);
    const { activePlan, globalMultiplier } = get();
    set({
      globalFreightIskPerM3: value,
      ...computeEffective(activePlan, globalMultiplier, value),
    });
  },
}));
