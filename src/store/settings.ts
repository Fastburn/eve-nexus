// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { create } from "zustand";
import {
  getAnalyticsConsent,
  setAnalyticsConsent,
  getStructureProfiles,
  saveStructureProfile,
  deleteStructureProfile,
  getBlueprintOverrides,
  setBlueprintOverride,
  clearBlueprintOverride,
  getManualDecisions,
  setManualDecision,
  clearManualDecision,
  getBlacklist,
  addToBlacklist,
  removeFromBlacklist,
  getVirtualHangar,
  setHangarQuantity,
  getBpcInventory,
  setBpcStock,
  getDecrypterChoices,
  setDecrypterChoice,
  clearDecrypterChoice,
  listDecrypters,
} from "../api";
import type {
  AnalyticsConsent,
  BlueprintOverrideEntry,
  BpcStockEntry,
  Decision,
  DecrypterChoiceEntry,
  DecrypterSpecEntry,
  ManualDecisionEntry,
  StructureProfile,
  TypeId,
} from "../api";

interface SettingsState {
  // ── Data ──────────────────────────────────────────────────────────────────
  analyticsConsent: AnalyticsConsent;
  structureProfiles: StructureProfile[];
  blueprintOverrides: BlueprintOverrideEntry[];
  manualDecisions: ManualDecisionEntry[];
  blacklist: TypeId[];
  /** typeId → quantity */
  hangar: Record<TypeId, number>;
  /** typeId → owned BPC stock */
  bpcInventory: Record<TypeId, BpcStockEntry>;
  decrypterChoices: DecrypterChoiceEntry[];
  /** Static table of all 8 T2 decrypters, for populating pickers. */
  decrypterSpecs: DecrypterSpecEntry[];

  // ── Actions ───────────────────────────────────────────────────────────────
  /** Load all settings from the DB — call once on app init. */
  init: () => Promise<void>;

  setConsent: (consent: AnalyticsConsent) => Promise<void>;

  saveProfile: (profile: StructureProfile) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;

  setOverride: (typeId: TypeId, meLevel: number, teLevel: number) => Promise<void>;
  clearOverride: (typeId: TypeId) => Promise<void>;

  setDecision: (typeId: TypeId, decision: Decision) => Promise<void>;
  clearDecision: (typeId: TypeId) => Promise<void>;

  addBlacklist: (typeId: TypeId) => Promise<void>;
  removeBlacklist: (typeId: TypeId) => Promise<void>;

  setHangarQty: (typeId: TypeId, quantity: number) => Promise<void>;

  setBpcStockEntry: (
    typeId: TypeId,
    meLevel: number,
    teLevel: number,
    runsRemaining: number,
  ) => Promise<void>;

  setDecrypterChoice: (typeId: TypeId, decrypterTypeId: TypeId) => Promise<void>;
  clearDecrypterChoice: (typeId: TypeId) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  analyticsConsent: "Pending",
  structureProfiles: [],
  blueprintOverrides: [],
  manualDecisions: [],
  blacklist: [],
  hangar: {},
  bpcInventory: {},
  decrypterChoices: [],
  decrypterSpecs: [],

  init: async () => {
    const [
      consent,
      profiles,
      overrides,
      decisions,
      blacklist,
      hangar,
      bpcInventory,
      decrypterChoices,
      decrypterSpecs,
    ] = await Promise.all([
      getAnalyticsConsent(),
      getStructureProfiles(),
      getBlueprintOverrides(),
      getManualDecisions(),
      getBlacklist(),
      getVirtualHangar(),
      getBpcInventory(),
      getDecrypterChoices(),
      listDecrypters(),
    ]);
    set({
      analyticsConsent: consent,
      structureProfiles: profiles,
      blueprintOverrides: overrides,
      manualDecisions: decisions,
      blacklist,
      hangar,
      bpcInventory,
      decrypterChoices,
      decrypterSpecs,
    });
  },

  setConsent: async (consent) => {
    await setAnalyticsConsent(consent);
    set({ analyticsConsent: consent });
  },

  saveProfile: async (profile) => {
    await saveStructureProfile(profile);
    set((s) => {
      const rest = s.structureProfiles.filter((p) => p.id !== profile.id);
      return { structureProfiles: [...rest, profile] };
    });
  },

  deleteProfile: async (id) => {
    await deleteStructureProfile(id);
    set((s) => ({
      structureProfiles: s.structureProfiles.filter((p) => p.id !== id),
    }));
  },

  setOverride: async (typeId, meLevel, teLevel) => {
    await setBlueprintOverride(typeId, meLevel, teLevel);
    set((s) => {
      const rest = s.blueprintOverrides.filter((o) => o.typeId !== typeId);
      return { blueprintOverrides: [...rest, { typeId, meLevel, teLevel }] };
    });
  },

  clearOverride: async (typeId) => {
    await clearBlueprintOverride(typeId);
    set((s) => ({
      blueprintOverrides: s.blueprintOverrides.filter((o) => o.typeId !== typeId),
    }));
  },

  setDecision: async (typeId, decision) => {
    await setManualDecision(typeId, decision);
    set((s) => {
      const rest = s.manualDecisions.filter((d) => d.typeId !== typeId);
      return { manualDecisions: [...rest, { typeId, decision }] };
    });
  },

  clearDecision: async (typeId) => {
    await clearManualDecision(typeId);
    set((s) => ({
      manualDecisions: s.manualDecisions.filter((d) => d.typeId !== typeId),
    }));
  },

  addBlacklist: async (typeId) => {
    await addToBlacklist(typeId);
    set((s) => ({
      blacklist: s.blacklist.includes(typeId)
        ? s.blacklist
        : [...s.blacklist, typeId],
    }));
  },

  removeBlacklist: async (typeId) => {
    await removeFromBlacklist(typeId);
    set((s) => ({
      blacklist: s.blacklist.filter((id) => id !== typeId),
    }));
  },

  setHangarQty: async (typeId, quantity) => {
    await setHangarQuantity(typeId, quantity);
    set((s) => {
      const hangar = { ...s.hangar };
      if (quantity === 0) {
        delete hangar[typeId];
      } else {
        hangar[typeId] = quantity;
      }
      return { hangar };
    });
  },

  setBpcStockEntry: async (typeId, meLevel, teLevel, runsRemaining) => {
    await setBpcStock(typeId, meLevel, teLevel, runsRemaining);
    set((s) => {
      const bpcInventory = { ...s.bpcInventory };
      if (runsRemaining === 0) {
        delete bpcInventory[typeId];
      } else {
        bpcInventory[typeId] = { meLevel, teLevel, runsRemaining };
      }
      return { bpcInventory };
    });
  },

  setDecrypterChoice: async (typeId, decrypterTypeId) => {
    await setDecrypterChoice(typeId, decrypterTypeId);
    set((s) => {
      const rest = s.decrypterChoices.filter((d) => d.typeId !== typeId);
      return { decrypterChoices: [...rest, { typeId, decrypterTypeId }] };
    });
  },

  clearDecrypterChoice: async (typeId) => {
    await clearDecrypterChoice(typeId);
    set((s) => ({
      decrypterChoices: s.decrypterChoices.filter((d) => d.typeId !== typeId),
    }));
  },
}));