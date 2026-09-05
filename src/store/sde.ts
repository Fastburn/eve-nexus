// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { create } from "zustand";
import {
  getSdeStatus,
  getSdeVersion,
  triggerSdeUpdate,
  onSdeDownloadProgress,
  onSdeImportProgress,
  onSdeResult,
} from "../api";
import type {
  SdeDownloadProgress,
  SdeImportProgress,
  SdeUpdateResult,
  SdeVersionInfo,
} from "../api";
import { esiErrorMessage } from "../lib/format";

interface SdeState {
  // ── Data ──────────────────────────────────────────────────────────────────
  available: boolean;
  version: SdeVersionInfo | null;

  // ── Update lifecycle ──────────────────────────────────────────────────────
  updateInProgress: boolean;
  downloadProgress: SdeDownloadProgress | null;
  importProgress: SdeImportProgress | null;
  lastResult: SdeUpdateResult | null;

  // ── Actions ───────────────────────────────────────────────────────────────
  /** Check SDE availability and version on app launch. */
  init: () => Promise<void>;
  /** Trigger a manual version check + download if stale. */
  triggerUpdate: () => Promise<void>;
}

// Unlisten functions from the event listeners registered in init(), so a
// second init() call (e.g. a future HMR-safe re-init path) tears down the
// previous listeners instead of stacking duplicates.
let sdeUnlisten: Array<() => void> = [];

export const useSdeStore = create<SdeState>((set) => ({
  available: false,
  version: null,
  updateInProgress: false,
  downloadProgress: null,
  importProgress: null,
  lastResult: null,

  init: async () => {
    // Tear down any listeners from a previous init() call before re-registering.
    sdeUnlisten.forEach((unlisten) => unlisten());
    sdeUnlisten = [];

    try {
      const [status, version] = await Promise.all([
        getSdeStatus(),
        getSdeVersion(),
      ]);
      set({ available: status.available, version });

      // Attach event listeners for the background update that fires on launch.
      sdeUnlisten.push(await onSdeDownloadProgress((p) => set({ downloadProgress: p })));
      sdeUnlisten.push(await onSdeImportProgress((p) => set({ importProgress: p })));
      sdeUnlisten.push(await onSdeResult((r) => {
        set((s) => ({
          lastResult: r,
          updateInProgress: false,
          downloadProgress: null,
          importProgress: null,
          available: r.status === "updated" ? true : s.available,
        }));
        // Refresh version metadata after a successful update.
        if (r.status === "updated") {
          getSdeVersion().then((v) => set({ version: v }));
        }
      }));
    } catch (e) {
      // Don't let an SDE status failure abort the rest of the boot sequence
      // (initApp awaits this alongside settings/character/plan init in one Promise.all).
      console.error("[eve-nexus] SDE init failed:", esiErrorMessage(e));
    }
  },

  triggerUpdate: async () => {
    set({
      updateInProgress: true,
      downloadProgress: null,
      importProgress: null,
      lastResult: null,
    });
    await triggerSdeUpdate();
    // Result arrives via the "sde://result" event listener set up in init().
  },
}));