import { useEffect } from "react";
import { usePlanStore, useSolverStore, useSettingsStore, useUiStore } from "../../store";
import { Sidebar } from "./Sidebar";
import { Toolbar } from "./Toolbar";
import { StatusBar } from "./StatusBar";
import { RightPanel } from "./RightPanel";
import { BlueprintBrowser } from "../browser/BlueprintBrowser";
import { GraphView } from "../graph/GraphView";
import { GridView } from "../grid/GridView";
import { SdeBanner, ConsentDialog, UpdateBanner, AboutDialog, SettingsModal, CharactersModal } from "../overlays";
import { FirstRunWizard } from "../overlays/FirstRunWizard";
import { AdvisorPanel } from "../advisor/AdvisorPanel";
import { MarketView } from "../../views/MarketView";
import "./Shell.css";

export function Shell() {
  const rightPanelOpen  = useUiStore((s) => s.rightPanelOpen);
  const closeRightPanel = useUiStore((s) => s.closeRightPanel);
  const showAbout       = useUiStore((s) => s.showAbout);
  const setShowAbout    = useUiStore((s) => s.setShowAbout);
  const showConsent     = useUiStore((s) => s.showConsentDialog);
  const mainView        = useUiStore((s) => s.mainView);

  const activePlan  = usePlanStore((s) => s.activePlan);
  const targets     = usePlanStore((s) => s.targets);
  const saveCurrent = usePlanStore((s) => s.saveCurrent);
  const isDirty     = usePlanStore((s) => s.isDirty);

  const showWizard         = useUiStore((s) => s.showWizard);
  const setShowWizard      = useUiStore((s) => s.setShowWizard);
  const solving            = useSolverStore((s) => s.solving);
  const solverError        = useSolverStore((s) => s.error);
  const solverWarnings     = useSolverStore((s) => s.warnings);
  const dismissError       = useSolverStore((s) => s.dismissError);
  const dismissWarnings    = useSolverStore((s) => s.dismissWarnings);
  const solve              = useSolverStore((s) => s.solve);
  const blueprintOverrides = useSettingsStore((s) => s.blueprintOverrides);
  const structureProfiles  = useSettingsStore((s) => s.structureProfiles);
  const manualDecisions    = useSettingsStore((s) => s.manualDecisions);
  const blacklist          = useSettingsStore((s) => s.blacklist);

  // ── Global keyboard shortcuts ─────────────────────────────────────────────
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const ctrl = e.ctrlKey || e.metaKey;

      // Ctrl/Cmd+S — save current plan
      if (ctrl && e.key === "s") {
        e.preventDefault();
        if (targets.length === 0) return;
        const name = activePlan?.name ?? "Untitled plan";
        saveCurrent(name);
        return;
      }

      // Ctrl/Cmd+Enter — solve
      if (ctrl && e.key === "Enter") {
        e.preventDefault();
        if (targets.length === 0 || solving) return;
        const meLevels: Record<number, number> = {};
        const teLevels: Record<number, number> = {};
        for (const o of blueprintOverrides) {
          meLevels[o.typeId] = o.meLevel;
          teLevels[o.typeId] = o.teLevel;
        }
        const profileMap: Record<string, (typeof structureProfiles)[number]> = {};
        for (const p of structureProfiles) profileMap[p.id] = p;
        const decisionMap: Record<number, (typeof manualDecisions)[number]["decision"]> = {};
        for (const d of manualDecisions) decisionMap[d.typeId] = d.decision;
        solve({ targets, meLevels, teLevels, structureProfiles: profileMap, manualDecisions: decisionMap, blacklist });
        return;
      }

      // Escape — close topmost overlay, then right panel
      if (e.key === "Escape") {
        if (showAbout)  { setShowAbout(false);    return; }
        if (showConsent) return; // consent dialog handles its own close
        if (rightPanelOpen) { closeRightPanel(); return; }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activePlan, targets, saveCurrent, isDirty, solving, solve,
    blueprintOverrides, structureProfiles, manualDecisions, blacklist,
    showAbout, setShowAbout, showConsent, rightPanelOpen, closeRightPanel,
  ]);

  return (
    <div className={`shell${rightPanelOpen ? " panel-open" : ""}`}>
      <div className="shell-sidebar">
        <Sidebar />
      </div>

      <div className="shell-toolbar">
        <Toolbar />
      </div>

      <main className="shell-main" id="main-canvas">
        {solverWarnings.length > 0 && (
          <div className="shell-warning-banner">
            {solverWarnings.map((w, i) => (
              <span key={i} className="shell-warning-text">⚠ {w}</span>
            ))}
            <button className="shell-error-dismiss" onClick={dismissWarnings}>×</button>
          </div>
        )}
        {solverError && (
          <div className="shell-error-banner">
            <span className="shell-error-text">⚠ Solve failed: {solverError}</span>
            <a
              href="https://github.com/fastburn/eve-nexus/issues"
              target="_blank"
              rel="noopener"
              className="shell-error-report"
            >
              Report issue
            </a>
            <button className="shell-error-dismiss" onClick={dismissError}>×</button>
          </div>
        )}
        {mainView === "graph"   && <GraphView />}
        {mainView === "grid"    && <GridView />}
        {mainView === "browser" && <BlueprintBrowser />}
        {mainView === "advisor" && <AdvisorPanel />}
        {mainView === "market"  && <MarketView />}
      </main>

      {rightPanelOpen && (
        <div className="shell-panel">
          <RightPanel />
        </div>
      )}

      <StatusBar />

      {/* Overlays — rendered last so they sit above everything */}
      <SdeBanner />
      {!showWizard && <ConsentDialog />}
      <UpdateBanner />
      <AboutDialog />
      <SettingsModal />
      <CharactersModal />
      {showWizard && <FirstRunWizard onComplete={() => setShowWizard(false)} />}
    </div>
  );
}
