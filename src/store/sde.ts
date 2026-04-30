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

export const useSdeStore = create<SdeState>((set) => ({
  available: false,
  version: null,
  updateInProgress: false,
  downloadProgress: null,
  importProgress: null,
  lastResult: null,

  init: async () => {
    const [status, version] = await Promise.all([
      getSdeStatus(),
      getSdeVersion(),
    ]);
    set({ available: status.available, version });

    // Attach event listeners for the background update that fires on launch.
    await onSdeDownloadProgress((p) => set({ downloadProgress: p }));
    await onSdeImportProgress((p) => set({ importProgress: p }));
    await onSdeResult((r) => {
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
    });
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
