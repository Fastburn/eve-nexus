import { create } from "zustand";

export type MainView = "graph" | "grid" | "browser" | "advisor" | "market";
export type RightPanelTab =
  | "nodeDetail"
  | "settings"
  | "characters"
  | "monitoring";

export type ThemeId = "default" | "amarr" | "caldari" | "gallente" | "minmatar" | "jove" | "light";

/** Single source of truth for valid theme IDs — used for validation and the settings picker. */
export const VALID_THEMES: ThemeId[] = ["default", "amarr", "caldari", "gallente", "minmatar", "jove", "light"];

const THEME_STORAGE_KEY = "eve-nexus-theme";

function loadTheme(): ThemeId {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v && (VALID_THEMES as string[]).includes(v)) return v as ThemeId;
  } catch { /* ignore */ }
  return "default";
}

function applyTheme(id: ThemeId) {
  document.documentElement.setAttribute("data-theme", id);
  try { localStorage.setItem(THEME_STORAGE_KEY, id); } catch { /* ignore */ }
}

interface UiState {
  // ── Main canvas ───────────────────────────────────────────────────────────
  /** "graph" = React Flow canvas; "grid" = spreadsheet/table view. */
  mainView: MainView;

  // ── Node selection ────────────────────────────────────────────────────────
  /** React Flow node ID of the currently selected node, or null. */
  selectedNodeId: string | null;

  // ── Right panel ───────────────────────────────────────────────────────────
  rightPanelOpen: boolean;
  rightPanelTab: RightPanelTab;

  // ── SDE update banner ─────────────────────────────────────────────────────
  showSdeBanner: boolean;

  // ── First-run wizard ─────────────────────────────────────────────────────
  showWizard: boolean;

  // ── First-run analytics consent dialog (legacy — suppressed when wizard shown) ──
  showConsentDialog: boolean;

  // ── App update available banner ───────────────────────────────────────────
  showUpdateBanner: boolean;

  // ── About dialog ─────────────────────────────────────────────────────────
  showAbout: boolean;

  // ── Settings modal ────────────────────────────────────────────────────────
  showSettings: boolean;

  // ── Characters modal ──────────────────────────────────────────────────────
  showCharacters: boolean;

  // ── Theme ─────────────────────────────────────────────────────────────────
  theme: ThemeId;

  // ── Actions ───────────────────────────────────────────────────────────────
  setMainView: (view: MainView) => void;
  setTheme: (theme: ThemeId) => void;
  selectNode: (id: string | null) => void;
  openRightPanel: (tab?: RightPanelTab) => void;
  closeRightPanel: () => void;
  setRightPanelTab: (tab: RightPanelTab) => void;
  setSdeBanner: (show: boolean) => void;
  setShowWizard: (show: boolean) => void;
  setConsentDialog: (show: boolean) => void;
  setUpdateBanner: (show: boolean) => void;
  setShowAbout: (show: boolean) => void;
  setShowSettings: (show: boolean) => void;
  setShowCharacters: (show: boolean) => void;
}

// Apply saved theme immediately on module load (before first render).
applyTheme(loadTheme());

export const useUiStore = create<UiState>((set) => ({
  mainView: "graph",
  selectedNodeId: null,
  rightPanelOpen: false,
  rightPanelTab: "nodeDetail",
  showSdeBanner: false,
  showWizard: false,
  showConsentDialog: false,
  showUpdateBanner: false,
  showAbout: false,
  showSettings: false,
  showCharacters: false,
  theme: loadTheme(),

  setMainView: (mainView) => set({ mainView }),

  selectNode: (selectedNodeId) => {
    set({ selectedNodeId });
    // Auto-open the detail panel when a node is selected.
    if (selectedNodeId !== null) {
      set({ rightPanelOpen: true, rightPanelTab: "nodeDetail" });
    }
  },

  openRightPanel: (tab) =>
    set((s) => ({
      rightPanelOpen: true,
      rightPanelTab: tab ?? s.rightPanelTab,
    })),

  closeRightPanel: () => set({ rightPanelOpen: false }),

  setRightPanelTab: (rightPanelTab) => set({ rightPanelTab }),

  setSdeBanner: (showSdeBanner) => set({ showSdeBanner }),
  setShowWizard: (showWizard) => set({ showWizard }),

  setConsentDialog: (showConsentDialog) => set({ showConsentDialog }),

  setUpdateBanner: (showUpdateBanner) => set({ showUpdateBanner }),

  setShowAbout: (showAbout) => set({ showAbout }),
  setShowSettings: (showSettings) => set({ showSettings }),
  setShowCharacters: (showCharacters) => set({ showCharacters }),

  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
}));
