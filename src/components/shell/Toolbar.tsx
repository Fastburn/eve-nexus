import { useState } from "react";
import { usePlanStore, useSolverStore, useSettingsStore, useUiStore } from "../../store";
import "./Toolbar.css";

const fmtMultiplier = (v: number) => v === 1 ? "×1" : `×${v % 1 === 0 ? v : v.toFixed(2)}`;

export function Toolbar() {
  const [saveName, setSaveName]             = useState("");
  const [showSaveInput, setShowSaveInput]   = useState(false);
  const [editingMult, setEditingMult]       = useState(false);
  const [multInput, setMultInput]           = useState("");

  const activePlan         = usePlanStore((s) => s.activePlan);
  const isDirty            = usePlanStore((s) => s.isDirty);
  const targets            = usePlanStore((s) => s.targets);
  const saveCurrent        = usePlanStore((s) => s.saveCurrent);
  const effectiveMultiplier   = usePlanStore((s) => s.effectiveMultiplier);
  const setPlanMultiplier     = usePlanStore((s) => s.setPlanMultiplier);

  const solving = useSolverStore((s) => s.solving);
  const solve   = useSolverStore((s) => s.solve);

  // Settings used to build the solve request from in-memory state.
  const blueprintOverrides = useSettingsStore((s) => s.blueprintOverrides);
  const structureProfiles  = useSettingsStore((s) => s.structureProfiles);
  const manualDecisions    = useSettingsStore((s) => s.manualDecisions);
  const blacklist          = useSettingsStore((s) => s.blacklist);

  const mainView        = useUiStore((s) => s.mainView);
  const setMainView     = useUiStore((s) => s.setMainView);
  const rightPanelOpen  = useUiStore((s) => s.rightPanelOpen);
  const openRightPanel  = useUiStore((s) => s.openRightPanel);
  const closeRightPanel = useUiStore((s) => s.closeRightPanel);

  function handleSolve() {
    if (targets.length === 0 || solving) return;

    // Build the request from current in-memory state — works whether the plan
    // is saved or not, and always reflects the latest targets + settings.
    const meLevels: Record<number, number> = {};
    const teLevels: Record<number, number> = {};
    for (const o of blueprintOverrides) {
      meLevels[o.typeId] = o.meLevel;
      teLevels[o.typeId] = o.teLevel;
    }

    const profileMap: Record<string, (typeof structureProfiles)[number]> = {};
    for (const p of structureProfiles) {
      profileMap[p.id] = p;
    }

    const decisionMap: Record<number, (typeof manualDecisions)[number]["decision"]> = {};
    for (const d of manualDecisions) {
      decisionMap[d.typeId] = d.decision;
    }

    // Apply overproduction multiplier — scale all target quantities.
    const scaledTargets = effectiveMultiplier === 1
      ? targets
      : targets.map((t) => ({ ...t, quantity: Math.ceil(t.quantity * effectiveMultiplier) }));

    solve({
      targets: scaledTargets,
      meLevels,
      teLevels,
      structureProfiles: profileMap,
      manualDecisions: decisionMap,
      blacklist,
    });
  }

  function handleMultClick() {
    setMultInput(String(effectiveMultiplier));
    setEditingMult(true);
  }

  function handleMultCommit() {
    setEditingMult(false);
    const v = parseFloat(multInput);
    if (!isNaN(v) && v >= 1 && v <= 20) {
      // 1.0 = no override (clear back to global default behaviour)
      setPlanMultiplier(v === 1 ? undefined : v);
    }
  }

  function handleSaveSubmit(e: React.FormEvent) {
    e.preventDefault();
    const name = saveName.trim() || activePlan?.name || "Untitled plan";
    saveCurrent(name).then(() => {
      setShowSaveInput(false);
      setSaveName("");
    });
  }

  function handleSaveClick() {
    if (!activePlan) {
      setSaveName("");
      setShowSaveInput(true);
    } else {
      saveCurrent(activePlan.name);
    }
  }

  const canSolve = targets.length > 0 && !solving;

  return (
    <div className="toolbar">
      {/* Plan identity */}
      <div className="toolbar-plan">
        {showSaveInput ? (
          <form onSubmit={handleSaveSubmit} style={{ display: "flex", gap: "var(--sp-2)" }}>
            <input
              autoFocus
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="Plan name…"
              style={{ width: 160 }}
            />
            <button type="submit" className="toolbar-save-btn">Save</button>
            <button type="button" className="toolbar-save-btn" onClick={() => setShowSaveInput(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <>
            <span className={`toolbar-plan-name${!activePlan ? " placeholder" : ""}`}>
              {activePlan?.name ?? "No plan open"}
            </span>
            {isDirty && <span className="toolbar-dirty-dot" title="Unsaved changes" />}
            {(isDirty || !activePlan) && targets.length > 0 && (
              <button className="toolbar-save-btn" onClick={handleSaveClick}>
                {activePlan ? "Save" : "Save as…"}
              </button>
            )}
            {activePlan && (
              editingMult ? (
                <input
                  autoFocus
                  type="number"
                  className="toolbar-mult-input"
                  value={multInput}
                  min={1}
                  max={20}
                  step={0.5}
                  onChange={(e) => setMultInput(e.target.value)}
                  onBlur={handleMultCommit}
                  onKeyDown={(e) => { if (e.key === "Enter") handleMultCommit(); else if (e.key === "Escape") setEditingMult(false); }}
                />
              ) : (
                <button
                  className={`toolbar-mult-chip${effectiveMultiplier !== 1 ? " active" : ""}`}
                  onClick={handleMultClick}
                  title="Overproduction multiplier — scale all target quantities before solving. ×1 = build exactly what the plan says. ×2 = build double, keeping the extra as stock."
                >
                  {fmtMultiplier(effectiveMultiplier)}
                </button>
              )
            )}
          </>
        )}
      </div>

      {/* View toggle */}
      <div className="toolbar-view-toggle">
        <button
          className={`toolbar-view-btn${mainView === "graph" ? " active" : ""}`}
          onClick={() => setMainView("graph")}
          title="Production graph — visual dependency tree of your build plan"
        >
          Graph
        </button>
        <button
          className={`toolbar-view-btn${mainView === "grid" ? " active" : ""}`}
          onClick={() => setMainView("grid")}
          title="Grid view — flat table with quantities, job costs, and buy-vs-build breakdown"
        >
          Grid
        </button>
        <button
          className={`toolbar-view-btn${mainView === "browser" ? " active" : ""}`}
          onClick={() => setMainView("browser")}
          title="Blueprint browser — find blueprints by category or search, see which ones you own"
        >
          Blueprints
        </button>
        <button
          className={`toolbar-view-btn${mainView === "advisor" ? " active" : ""}`}
          onClick={() => setMainView("advisor")}
          title="Advisor — suggestions to improve your build plan (cheaper structures, buy-vs-build tips)"
        >
          Advisor
        </button>
        <button
          className={`toolbar-view-btn${mainView === "market" ? " active" : ""}`}
          onClick={() => setMainView("market")}
          title="Market analyser — compare hub prices, spot arbitrage, and check build vs buy"
        >
          Market
        </button>
      </div>

      {/* Actions */}
      <div className="toolbar-actions">
        <button
          className="toolbar-solve-btn"
          onClick={handleSolve}
          disabled={!canSolve}
          title={targets.length === 0 ? "Add build targets first" : "Solve build plan (Ctrl+Enter)"}
        >
          {solving ? <span className="spinner" /> : null}
          {solving ? "Solving…" : "Solve"}
        </button>

        <button
          className={`toolbar-panel-toggle${rightPanelOpen ? " active" : ""}`}
          onClick={() => rightPanelOpen ? closeRightPanel() : openRightPanel()}
          title={rightPanelOpen ? "Close panel" : "Open panel"}
        >
          {rightPanelOpen ? "◀" : "▶"}
        </button>
      </div>
    </div>
  );
}
