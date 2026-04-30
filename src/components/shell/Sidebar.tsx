import { useEffect, useRef, useState } from "react";
import { getTypeNames } from "../../api";
import { usePlanStore, useSettingsStore, useUiStore } from "../../store";
import { TypeIcon, TypePicker, Select } from "../common";
import type { TypeSummary, BuildTarget } from "../../api";
import type { EftItem } from "../../api/eft";
import { EftImportDialog } from "../overlays/EftImportDialog";
import sidebarLogo from "../../assets/eve-nexus-sidebar.png";
import "./Sidebar.css";

export function Sidebar() {
  const plans        = usePlanStore((s) => s.plans);
  const activePlan   = usePlanStore((s) => s.activePlan);
  const isDirty      = usePlanStore((s) => s.isDirty);
  const targets      = usePlanStore((s) => s.targets);
  const openPlan     = usePlanStore((s) => s.openPlan);
  const newPlan      = usePlanStore((s) => s.newPlan);
  const removePlan   = usePlanStore((s) => s.deletePlan);
  const renamePlan   = usePlanStore((s) => s.renamePlan);
  const addTarget    = usePlanStore((s) => s.addTarget);
  const saveCurrent  = usePlanStore((s) => s.saveCurrent);
  const removeTarget = usePlanStore((s) => s.removeTarget);
  const updateTarget = usePlanStore((s) => s.updateTarget);

  const profiles     = useSettingsStore((s) => s.structureProfiles);

  const setMainView      = useUiStore((s) => s.setMainView);
  const setShowAbout     = useUiStore((s) => s.setShowAbout);
  const setShowSettings  = useUiStore((s) => s.setShowSettings);
  const setShowCharacters= useUiStore((s) => s.setShowCharacters);

  const [typeNames, setTypeNames]     = useState<Record<number, string>>({});
  const [renamingId, setRenamingId]   = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [showEftImport, setShowEftImport] = useState(false);
  const renameInputRef                = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const ids = targets.map((t) => t.typeId);
    if (ids.length === 0) { setTypeNames({}); return; }
    getTypeNames(ids).then(names => setTypeNames(prev => ({ ...prev, ...names }))).catch(() => {});
  }, [targets]);

  async function handleEftImport(items: EftItem[], fitName: string) {
    try {
      const id = await newPlan();
      const namesFromImport: Record<number, string> = {};
      for (const item of items) {
        const target: BuildTarget = { typeId: item.typeId, quantity: item.quantity, structureProfileId: null };
        addTarget(target);
        namesFromImport[item.typeId] = item.typeName;
      }
      setTypeNames((prev) => ({ ...namesFromImport, ...prev }));
      await saveCurrent(fitName);
      setRenamingId(id);
      setRenameValue(fitName);
      setTimeout(() => renameInputRef.current?.select(), 0);
    } catch (e) {
      console.error("[EFT import] failed to create plan:", e);
    }
  }

  function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    removePlan(id);
  }

  function startRename(e: React.MouseEvent, id: string, currentName: string) {
    e.stopPropagation();
    setRenamingId(id);
    setRenameValue(currentName);
    // Focus happens via useEffect after re-render.
    setTimeout(() => renameInputRef.current?.select(), 0);
  }

  function commitRename(id: string) {
    const name = renameValue.trim();
    if (name) renamePlan(id, name);
    setRenamingId(null);
  }

  function cancelRename() {
    setRenamingId(null);
  }

  function handlePickType(type: TypeSummary) {
    addTarget({ typeId: type.typeId, quantity: 1, structureProfileId: null });
  }

  function handleQtyChange(typeId: number, raw: string) {
    const qty = parseInt(raw, 10);
    if (!isNaN(qty) && qty > 0) updateTarget(typeId, { quantity: qty });
  }

  function handleProfileChange(typeId: number, raw: string) {
    updateTarget(typeId, { structureProfileId: raw === "" ? null : raw });
  }

  return (
    <>
    <nav className="sidebar">
      {/* Header */}
      <div className="sidebar-header">
        <div className="sidebar-logo-wrap">
          <img src={sidebarLogo} alt="Eve Nexus" className="sidebar-logo-img" />
        </div>
        <div className="sidebar-header-btns">
          <button
            className="sidebar-footer-btn"
            title="Characters &amp; ESI"
            onClick={() => setShowCharacters(true)}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <circle cx="7" cy="4.5" r="2.2" stroke="currentColor" strokeWidth="1.4"/>
              <path d="M2.5 12.5c0-2.485 2.015-4.5 4.5-4.5s4.5 2.015 4.5 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          </button>
          <button
            className="sidebar-footer-btn"
            title="Settings"
            onClick={() => setShowSettings(true)}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <line x1="1.5" y1="4" x2="12.5" y2="4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              <circle cx="9" cy="4" r="1.6" fill="var(--surface-1)" stroke="currentColor" strokeWidth="1.4"/>
              <line x1="1.5" y1="10" x2="12.5" y2="10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              <circle cx="5" cy="10" r="1.6" fill="var(--surface-1)" stroke="currentColor" strokeWidth="1.4"/>
            </svg>
          </button>
          <button
            className="sidebar-footer-btn"
            title="About Eve Nexus"
            onClick={() => setShowAbout(true)}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.4"/>
              <line x1="7" y1="6.5" x2="7" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              <circle cx="7" cy="4.2" r="0.9" fill="currentColor"/>
            </svg>
          </button>
        </div>
      </div>

      {/* New plan / Import fit */}
      <div className="sidebar-actions">
        <button className="sidebar-new-btn" onClick={async () => {
          const id = await newPlan();
          setRenamingId(id);
          setRenameValue("New Plan");
          setTimeout(() => renameInputRef.current?.select(), 0);
        }}>
          + New Plan
        </button>
        <button className="sidebar-import-btn" onClick={() => setShowEftImport(true)}>
          Import
        </button>
      </div>

      {/* Plan list */}
      <span className="sidebar-section-label">Plans</span>

      <div className="sidebar-plans">
        {plans.length === 0 ? (
          <p className="sidebar-empty">No plans yet</p>
        ) : (
          plans.map((p) => {
            const isActive = activePlan?.id === p.id;
            const isRenaming = renamingId === p.id;
            return (
              <div
                key={p.id}
                className={`sidebar-plan-item${isActive ? " active" : ""}`}
                onClick={() => !isRenaming && openPlan(p.id)}
                title={isRenaming ? undefined : p.name}
              >
                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    className="sidebar-plan-rename-input"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => commitRename(p.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); commitRename(p.id); }
                      if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
                    }}
                    onClick={(e) => e.stopPropagation()}
                    autoFocus
                  />
                ) : (
                  <span
                    className="sidebar-plan-name"
                    onDoubleClick={(e) => startRename(e, p.id, p.name)}
                    title="Double-click to rename"
                  >
                    {p.name}
                  </span>
                )}
                {isActive && isDirty && !isRenaming && (
                  <span className="sidebar-plan-dirty" title="Unsaved changes" />
                )}
                {!isRenaming && (
                  <span
                    className="sidebar-plan-delete"
                    role="button"
                    tabIndex={0}
                    aria-label={`Delete plan ${p.name}`}
                    onClick={(e) => handleDelete(e, p.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ")
                        handleDelete(e as unknown as React.MouseEvent, p.id);
                    }}
                  >
                    ×
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Build targets — always visible so users can add items before saving */}
      <div className="sidebar-targets">
        <span className="sidebar-section-label">Targets</span>

        <div className="sidebar-target-picker">
          <TypePicker placeholder="Quick-add item…" onSelect={handlePickType} />
        </div>

        <div className="sidebar-target-list">
          {targets.length === 0 ? (
            <p className="sidebar-empty">No targets — search above or browse blueprints</p>
          ) : (
            targets.map((t) => (
              <div key={t.typeId} className="sidebar-target-item">
                <TypeIcon typeId={t.typeId} variant="icon" size={32} displaySize={20} alt="" />
                <div className="sidebar-target-info">
                  <span
                    className="sidebar-target-name"
                    title={typeNames[t.typeId] ?? String(t.typeId)}
                  >
                    {typeNames[t.typeId] ?? `#${t.typeId}`}
                  </span>
                  {profiles.length > 0 && (
                    <Select
                      className="sidebar-target-profile"
                      value={t.structureProfileId ?? ""}
                      onChange={(val) => handleProfileChange(t.typeId, val)}
                      title="Structure profile"
                      options={[
                        { value: "", label: "No profile" },
                        ...profiles.map((p) => ({ value: p.id, label: p.label })),
                      ]}
                    />
                  )}
                </div>
                <input
                  className="sidebar-target-qty"
                  type="number"
                  min={1}
                  value={t.quantity}
                  onChange={(e) => handleQtyChange(t.typeId, e.target.value)}
                  title="Quantity"
                />
                <button
                  className="sidebar-target-remove"
                  onClick={() => removeTarget(t.typeId)}
                  title="Remove"
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>

        <button className="sidebar-targets-browse" onClick={() => setMainView("browser")}>
          ↗ Browse blueprints
        </button>
      </div>

    </nav>

    {showEftImport && (
      <EftImportDialog
        onClose={() => setShowEftImport(false)}
        onImport={handleEftImport}
      />
    )}
    </>
  );
}
