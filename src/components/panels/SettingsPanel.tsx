// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore, useUiStore, useMarketStore } from "../../store";
import { getTypeNames, getSystemCostInfo, searchMarketStructures, getAssetStructures } from "../../api";
import { getOptimizeDecryptersForTime, setOptimizeDecryptersForTime } from "../../api/settings";
import { listRigs } from "../../api/overrides";
import { getIndustryCategories } from "../../api/blueprints";
import { TypeIcon, TypePicker, SystemPicker, Select } from "../common";
import type { JobType, IndustryCategory, MarketRegion, RigSpecEntry, StructureProfile, StructureSearchResult, SystemCostInfo, TypeSummary } from "../../api";
import type { ThemeId } from "../../store";
import "./SettingsPanel.css";
import "../common/TypePicker.css";

// ── Helpers ───────────────────────────────────────────────────────────────────

function newProfile(): StructureProfile {
  return {
    id: crypto.randomUUID(),
    label: "",
    solarSystemId: null,
    jobType: "Manufacturing",
    facilityTax: 0.1,
    spaceModifier: 1.0,
    rigBonuses: [],
    installedRigs: [],
  };
}

// ── Profile editor (inline form) ──────────────────────────────────────────────

interface ProfileEditorProps {
  initial: StructureProfile;
  onSave: (p: StructureProfile) => void;
  onCancel: () => void;
}

function ProfileEditor({ initial, onSave, onCancel }: ProfileEditorProps) {
  const [profile, setProfile] = useState<StructureProfile>(initial);
  const [systemName, setSystemName] = useState<string | null>(null);
  const [categories, setCategories] = useState<IndustryCategory[]>([]);
  const [rigSpecs, setRigSpecs] = useState<RigSpecEntry[]>([]);
  const [taxInput, setTaxInput]           = useState(() => (initial.facilityTax * 100).toFixed(1));
  const [modifierInput, setModifierInput] = useState(() => String(initial.spaceModifier));

  // Keep string inputs in sync if parent switches to a different profile without unmounting.
  useEffect(() => {
    setProfile(initial);
    setTaxInput((initial.facilityTax * 100).toFixed(1));
    setModifierInput(String(initial.spaceModifier));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.id]);

  useEffect(() => {
    getIndustryCategories().then(setCategories).catch(() => {});
  }, []);

  useEffect(() => {
    listRigs().then(setRigSpecs).catch(() => {});
  }, []);

  // Load the system name for an existing solarSystemId on mount.
  useEffect(() => {
    if (initial.solarSystemId !== null) {
      getSystemCostInfo(initial.solarSystemId)
        .then((info) => { if (info) setSystemName(info.systemName); })
        .catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setField<K extends keyof StructureProfile>(key: K, value: StructureProfile[K]) {
    setProfile((p) => ({ ...p, [key]: value }));
  }

  const rigByTypeId = new Map(rigSpecs.map((r) => [r.typeId, r]));
  const relevantRigSpecs = rigSpecs.filter((r) => r.jobType === profile.jobType);

  function addInstalledRig(typeId: number) {
    if (!typeId || profile.installedRigs.includes(typeId)) return;
    if (profile.installedRigs.length === 0 && profile.rigBonuses.length > 0) {
      const ok = window.confirm(
        "This profile has manually-entered rig bonuses. Picking a rig here switches it to automatic, picker-derived bonuses, replacing the manual entries. Continue?"
      );
      if (!ok) return;
    }
    setProfile((p) => ({ ...p, installedRigs: [...p.installedRigs, typeId] }));
  }

  function removeInstalledRig(typeId: number) {
    setProfile((p) => ({ ...p, installedRigs: p.installedRigs.filter((id) => id !== typeId) }));
  }

  function removeLegacyRig(i: number) {
    setProfile((p) => ({ ...p, rigBonuses: p.rigBonuses.filter((_, idx) => idx !== i) }));
  }

  // Live client-side preview of the resolved category bonuses, mirroring
  // the backend's elementwise-max conflict resolution in expand_installed_rigs.
  const rigPreview = new Map<string, { me: number; te: number }>();
  for (const typeId of profile.installedRigs) {
    const spec = rigByTypeId.get(typeId);
    if (!spec) continue;
    for (const name of spec.categoryNames) {
      const cur = rigPreview.get(name) ?? { me: 0, te: 0 };
      rigPreview.set(name, {
        me: Math.max(cur.me, spec.meBonus),
        te: Math.max(cur.te, spec.teBonus),
      });
    }
  }

  const valid = profile.label.trim().length > 0;

  return (
    <div className="sp-editor">
      <div className="sp-editor-title">
        {initial.label ? `Edit: ${initial.label}` : "New Structure Profile"}
      </div>

      <div className="sp-field">
        <label className="sp-label">Name</label>
        <input
          className="sp-input"
          type="text"
          value={profile.label}
          placeholder="e.g. Null-sec Sotiyo"
          onChange={(e) => setField("label", e.target.value)}
        />
      </div>

      <div className="sp-row">
        <div className="sp-field">
          <label className="sp-label" title="Which activity this profile applies to. Create separate profiles for manufacturing, reactions, and invention — each uses different structure bonuses.">Job Type</label>
          <Select
            className="sp-select"
            value={profile.jobType}
            onChange={(val) => setField("jobType", val as JobType)}
            options={[
              { value: "Manufacturing", label: "Manufacturing" },
              { value: "Reaction",      label: "Reaction"      },
              { value: "Invention",     label: "Invention"     },
            ]}
          />
        </div>
        <div className="sp-field">
          <label
            className="sp-label"
            title="The structure's industry tax rate. Find it in-game via the structure's Industry window. NPC stations charge 10% by default; player structures often charge 5–10%. Lower is better."
          >
            Facility Tax %
          </label>
          <input
            className="sp-input"
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={taxInput}
            onChange={(e) => setTaxInput(e.target.value)}
            onBlur={(e) => {
              const v = parseFloat(e.target.value);
              const clamped = isNaN(v) ? 0 : Math.min(100, Math.max(0, v));
              setField("facilityTax", clamped / 100);
              setTaxInput(clamped.toFixed(1));
            }}
          />
        </div>
      </div>

      <div className="sp-field">
        <label
          className="sp-label"
          title="A multiplier applied to the system cost index before calculating job cost. Use 1.0 for most cases. Some structures (e.g. Sotiyo) apply a % reduction to job costs — enter that as a decimal (e.g. 0.75 for −25%). Check the structure's bonuses in-game."
        >
          System Cost Index Modifier
        </label>
        <input
          className="sp-input"
          type="number"
          min={0}
          step={0.01}
          value={modifierInput}
          onChange={(e) => setModifierInput(e.target.value)}
          onBlur={(e) => {
            const v = parseFloat(e.target.value);
            const valid = isNaN(v) || v <= 0 ? 1 : v;
            setField("spaceModifier", valid);
            setModifierInput(String(valid));
          }}
        />
        <span className="sp-hint">
          1.0 = no bonus · 0.75 = Sotiyo −25% job cost · 0.85 = Azbel −15%
        </span>
      </div>

      <div className="sp-field">
        <label
          className="sp-label"
          title="The solar system where this structure is located. Used to look up the industry cost index, which is the largest factor in job installation cost."
        >
          Solar System
        </label>
        <SystemPicker
          placeholder="Search solar system…"
          currentName={systemName}
          onSelect={(s) => {
            setSystemName(s.systemName);
            setField("solarSystemId", s.systemId);
          }}
        />
        {profile.solarSystemId !== null && (
          <button
            className="sp-clear-system"
            onClick={() => { setSystemName(null); setField("solarSystemId", null); }}
          >
            Clear system
          </button>
        )}
        <span className="sp-hint">
          Determines the cost index applied to job fees. Leave blank to use the spaceModifier directly.
        </span>
      </div>

      {profile.jobType !== "Invention" && (
        <div className="sp-field">
          <div className="sp-label-row">
            <label
              className="sp-label"
              title="Pick the rigs actually fitted to this structure by name — the app computes the ME/TE bonus for you. In-game, check the structure's Industry tab for installed rigs."
            >
              Structure Rigs
            </label>
          </div>

          {profile.installedRigs.length === 0 && profile.rigBonuses.length > 0 && (
            <div className="sp-rig-list">
              <div className="sp-rig-empty-tip" style={{ marginBottom: 4 }}>
                Legacy manual entries — pick a rig below to switch this profile to the
                automatic picker (replaces these).
              </div>
              <div className="sp-rig-header">
                <span>Category</span>
                <span>ME %</span>
                <span>TE %</span>
                <span />
              </div>
              {profile.rigBonuses.map((rig, i) => (
                <div key={i} className="sp-rig-row">
                  <span className="sp-rig-legacy-category">
                    {categories.find((c) => c.categoryId === rig.categoryId)?.categoryName ?? `#${rig.categoryId}`}
                  </span>
                  <span className="sp-rig-legacy-value">{(rig.meBonus * 100).toFixed(1)}%</span>
                  <span className="sp-rig-legacy-value">{(rig.teBonus * 100).toFixed(1)}%</span>
                  <button className="sp-rig-remove" onClick={() => removeLegacyRig(i)} title="Remove">
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <Select
            className="sp-select"
            value="0"
            onChange={(v) => addInstalledRig(parseInt(v, 10) || 0)}
            options={[
              { value: "0", label: "+ Add a rig…" },
              ...relevantRigSpecs
                .filter((r) => !profile.installedRigs.includes(r.typeId))
                .map((r) => ({ value: String(r.typeId), label: `${r.name} (T${r.tier})` })),
            ]}
          />

          {profile.installedRigs.length === 0 ? (
            <div className="sp-rig-empty">
              No rigs fitted. Pick one above to add its ME/TE bonus automatically.
            </div>
          ) : (
            <div className="sp-rig-chip-list">
              {profile.installedRigs.map((typeId) => {
                const spec = rigByTypeId.get(typeId);
                if (!spec) return null;
                return (
                  <span key={typeId} className="sp-rig-chip">
                    <span className="sp-rig-chip-name">{spec.name}</span>
                    <button
                      className="sp-rig-chip-remove"
                      onClick={() => removeInstalledRig(typeId)}
                      title="Remove rig"
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
          )}

          {rigPreview.size > 0 && (
            <div className="sp-rig-preview">
              {[...rigPreview.entries()].map(([name, { me, te }]) => (
                <span key={name} className="sp-rig-preview-badge">
                  {name}:
                  {me > 0 && ` +${(me * profile.spaceModifier * 100).toFixed(1)}% ME`}
                  {te > 0 && ` +${(te * profile.spaceModifier * 100).toFixed(1)}% TE`}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="sp-editor-actions">
        <button className="sp-btn-save" onClick={() => onSave(profile)} disabled={!valid}>
          Save Profile
        </button>
        <button className="sp-btn-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Profile cost index badge ──────────────────────────────────────────────────

function ProfileCostBadge({ profile }: { profile: StructureProfile }) {
  const [info, setInfo] = useState<SystemCostInfo | null>(null);

  useEffect(() => {
    if (profile.solarSystemId === null) { setInfo(null); return; }
    getSystemCostInfo(profile.solarSystemId)
      .then((r) => setInfo(r))
      .catch(() => {});
  }, [profile.solarSystemId]);

  if (!info) return null;

  const raw = profile.jobType === "Reaction" ? info.reaction : info.manufacturing;
  if (raw === null) return null; // no cost index data for this system (no industry activity recorded)
  const idx = raw;
  const pct = (idx * 100).toFixed(2);
  // Flag if cost index > 5% (roughly high-sec NPC station level) after modifier.
  const effective = idx * profile.spaceModifier;
  const isHigh = effective > 0.05;

  return (
    <span
      className={`sp-cost-badge${isHigh ? " sp-cost-badge-warn" : ""}`}
      title={`${info.systemName} · Raw cost index: ${pct}% · After modifier: ${(effective * 100).toFixed(2)}%`}
    >
      {info.systemName} · {pct}%
    </span>
  );
}

// ── Theme definitions ─────────────────────────────────────────────────────────

// Theme metadata for the settings picker. IDs must match VALID_THEMES in store/ui.ts.
const THEMES: { id: ThemeId; label: string; accent: string; bg: string; description: string }[] = [
  { id: "default",  label: "Default",  accent: "#4d9de0", bg: "#0b0f18", description: "Deep space dark" },
  { id: "amarr",    label: "Amarr",    accent: "#d49a1e", bg: "#0f0c05", description: "Gold empire" },
  { id: "caldari",  label: "Caldari",  accent: "#1890d8", bg: "#070b10", description: "Corporate steel" },
  { id: "gallente", label: "Gallente", accent: "#28b060", bg: "#070e0a", description: "Organic green" },
  { id: "minmatar", label: "Minmatar", accent: "#cc4818", bg: "#0e0806", description: "Tribal rust" },
  { id: "jove",     label: "Jove",     accent: "#7840e0", bg: "#08050e", description: "Ancient void" },
  { id: "light",    label: "Light",    accent: "#2d78d8", bg: "#f0f3f8", description: "Clean white" },
];

// ── Main panel ────────────────────────────────────────────────────────────────

// ── Market hub editor ─────────────────────────────────────────────────────────

const KNOWN_HUBS: { label: string; regionId: number }[] = [
  { label: "Jita (The Forge)",        regionId: 10000002 },
  { label: "Amarr (Domain)",          regionId: 10000043 },
  { label: "Dodixie (Sinq Laison)",   regionId: 10000032 },
  { label: "Rens (Heimatar)",         regionId: 10000030 },
  { label: "Hek (Metropolis)",        regionId: 10000042 },
];

function MarketHubEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: MarketRegion;
  onSave: (r: MarketRegion) => Promise<void>;
  onCancel: () => void;
}) {
  const isStructureInit = initial.structureId != null;
  const [hub, setHub]             = useState<MarketRegion>(initial);
  const [usePreset, setUsePreset] = useState(!isStructureInit);
  const [isStructure, setIsStructure] = useState(isStructureInit);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving]       = useState(false);

  // Structure search state
  const [structQuery, setStructQuery]   = useState(initial.label && isStructureInit ? initial.label : "");
  const [structResults, setStructResults] = useState<StructureSearchResult[]>([]);
  const [structOpen, setStructOpen]     = useState(false);
  const [structFocusIdx, setStructFocusIdx] = useState(-1);
  const [structError, setStructError]   = useState<string | null>(null);
  const [selectedStructure, setSelectedStructure] = useState<StructureSearchResult | null>(
    initial.structureId != null ? { structureId: initial.structureId, structureName: initial.label } : null
  );
  const structDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const structContainer = useRef<HTMLDivElement>(null);
  const [assetStructures, setAssetStructures] = useState<StructureSearchResult[]>([]);

  useEffect(() => {
    if (!isStructure) return;
    getAssetStructures().then(setAssetStructures).catch(() => {});
  }, [isStructure]);

  useEffect(() => {
    if (!isStructure) return;
    if (structDebounce.current) clearTimeout(structDebounce.current);
    if (!structQuery.trim() || structQuery === selectedStructure?.structureName) {
      // Empty query: show asset structures as default suggestions (don't auto-open).
      setStructResults(assetStructures);
      setStructOpen(false);
      return;
    }
    structDebounce.current = setTimeout(async () => {
      setStructError(null);
      try {
        const res = await searchMarketStructures(structQuery);
        setStructResults(res);
        setStructOpen(true);
        setStructFocusIdx(-1);
      } catch (e: unknown) {
        setStructResults([]);
        const msg = e != null && typeof e === "object" && "message" in e
          ? String((e as Record<string, unknown>).message) : String(e);
        setStructError(msg);
        setStructOpen(true);
      }
    }, 300);
    return () => { if (structDebounce.current) clearTimeout(structDebounce.current); };
  }, [structQuery, isStructure, selectedStructure, assetStructures]);

  useEffect(() => {
    let downOutside = false;
    function onDown(e: MouseEvent) {
      downOutside = !(structContainer.current?.contains(e.target as Node) ?? false);
    }
    function onUp(e: MouseEvent) {
      if (downOutside && !(structContainer.current?.contains(e.target as Node) ?? false)) {
        setStructOpen(false);
        if (selectedStructure) setStructQuery(selectedStructure.structureName);
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("mouseup", onUp);
    };
  }, [selectedStructure]);

  function handleSelectStructure(s: StructureSearchResult) {
    setSelectedStructure(s);
    setStructQuery(s.structureName);
    setStructResults([]);
    setStructOpen(false);
    setHub((h) => ({ ...h, label: s.structureName }));
  }

  function handleStructKeyDown(e: React.KeyboardEvent) {
    if (!structOpen) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setStructFocusIdx((i) => Math.min(i + 1, structResults.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setStructFocusIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && structFocusIdx >= 0) { e.preventDefault(); handleSelectStructure(structResults[structFocusIdx]); }
    else if (e.key === "Escape") { setStructOpen(false); if (selectedStructure) setStructQuery(selectedStructure.structureName); }
  }

  function applyPreset(regionId: number) {
    const preset = KNOWN_HUBS.find((h) => h.regionId === regionId);
    if (preset) setHub((h) => ({ ...h, label: preset.label, regionId: preset.regionId }));
  }

  async function handleSave() {
    let toSave: MarketRegion | null = null;
    if (isStructure && selectedStructure) {
      const sid = selectedStructure.structureId;
      toSave = { ...hub, label: hub.label || selectedStructure.structureName, regionId: sid, structureId: sid };
    } else if (!isStructure) {
      toSave = { ...hub, structureId: undefined };
    }
    if (!toSave) return;
    setSaveError(null);
    setSaving(true);
    try {
      await onSave(toSave);
    } catch (e: unknown) {
      const msg = e != null && typeof e === "object" && "message" in e
        ? String((e as Record<string, unknown>).message) : String(e);
      setSaveError(msg);
    } finally {
      setSaving(false);
    }
  }

  const valid = isStructure
    ? selectedStructure != null && hub.label.trim().length > 0
    : hub.label.trim().length > 0 && hub.regionId > 0;

  return (
    <div className="sp-editor">
      <div className="sp-editor-title">
        {initial.label ? `Edit: ${initial.label}` : "Add Market Hub"}
      </div>

      {/* Hub type toggle */}
      <div className="sp-field">
        <label className="sp-label">Hub type</label>
        <div className="sp-toggle-row">
          <button
            className={`sp-toggle-btn${!isStructure ? " active" : ""}`}
            onClick={() => setIsStructure(false)}
          >
            Region market
          </button>
          <button
            className={`sp-toggle-btn${isStructure ? " active" : ""}`}
            onClick={() => setIsStructure(true)}
          >
            Structure market
          </button>
        </div>
      </div>

      {!isStructure && (
        <div className="sp-field">
          <label className="sp-label">Quick select</label>
          <Select
            className="sp-select"
            value={usePreset ? String(hub.regionId) : ""}
            onChange={(val) => {
              setUsePreset(true);
              applyPreset(Number(val));
            }}
            options={[
              { value: "", label: "Custom…" },
              ...KNOWN_HUBS.map((h) => ({ value: String(h.regionId), label: h.label })),
            ]}
          />
        </div>
      )}

      <div className="sp-field">
        <label className="sp-label">Name</label>
        <input
          className="sp-input"
          type="text"
          value={hub.label}
          placeholder="Hub name"
          onChange={(e) => { setUsePreset(false); setHub((h) => ({ ...h, label: e.target.value })); }}
        />
      </div>

      {isStructure ? (
        <div className="sp-field">
          <label className="sp-label">Structure</label>
          <div className="type-picker" ref={structContainer}>
            <input
              type="search"
              value={structQuery}
              placeholder={assetStructures.length > 0 ? "Click to see your structures, or type to search…" : "Search structure name…"}
              onChange={(e) => { setStructQuery(e.target.value); setSelectedStructure(null); }}
              onFocus={() => { if (structResults.length > 0) setStructOpen(true); }}
              onKeyDown={handleStructKeyDown}
              autoComplete="off"
            />
            {structOpen && (
              <div className="type-picker-dropdown" role="listbox">
                {structError ? (
                  <div className="type-picker-empty" style={{ color: "var(--red)" }} title={structError}>
                    Search unavailable — check character is logged in
                  </div>
                ) : structResults.length === 0 ? (
                  <div className="type-picker-empty">No structures found</div>
                ) : (
                  <>
                    {!structQuery.trim() && (
                      <div className="type-picker-section-label">Your assets are in</div>
                    )}
                    {structResults.map((s, i) => (
                      <button
                        key={s.structureId}
                        className={`type-picker-item${i === structFocusIdx ? " focused" : ""}`}
                        role="option"
                        onMouseDown={(e) => { e.preventDefault(); handleSelectStructure(s); }}
                      >
                        <span className="type-picker-item-name">{s.structureName}</span>
                        <span style={{ fontSize: 10, color: "var(--text-3)", marginLeft: "auto" }}>
                          #{s.structureId}
                        </span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
          <div className="sp-hint">
            Click the field to see structures where you have assets, jobs, or orders. If a structure doesn't appear, you need assets, an active job, or a market order there — just having docking access isn't enough.<br />
            To add a private structure with no activity yet, paste its numeric ID directly into the field.
          </div>
        </div>
      ) : (
        <div className="sp-field">
          <label className="sp-label" title="The EVE region ID. Find it in the SDE or EVE University wiki.">
            Region ID
          </label>
          <input
            className="sp-input"
            type="number"
            min={1}
            value={hub.regionId || ""}
            onChange={(e) => { setUsePreset(false); setHub((h) => ({ ...h, regionId: Number(e.target.value) })); }}
          />
        </div>
      )}

      <div className="sp-field">
        <label className="sp-label">Local hub</label>
        <label className="sp-checkbox-label">
          <input
            type="checkbox"
            checked={hub.isLocal}
            onChange={(e) => setHub((h) => ({ ...h, isLocal: e.target.checked }))}
          />
          No freight applies when buying here
        </label>
        <div className="sp-hint">
          Flag the hub where you actually buy or sell, usually your home structure. This
          is required for the Grid's Best Source column: it compares this hub's price
          against your other configured hubs (adding freight to the non-local ones) and
          shows the cheapest option. With no hub flagged Local, Best Source stays blank.
        </div>
      </div>

      {saveError && (
        <div className="sp-hint" style={{ color: "var(--red)" }}>
          Save failed: {saveError}
        </div>
      )}

      <div className="sp-editor-actions">
        <button className="sp-btn-save" onClick={handleSave} disabled={!valid || saving}>
          {saving ? "Saving…" : "Save Hub"}
        </button>
        <button className="sp-btn-cancel" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function newHub(): MarketRegion {
  return { id: crypto.randomUUID(), label: "", regionId: 0, isDefault: false, isLocal: false };
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function SettingsPanel() {
  const currentTheme = useUiStore((s) => s.theme);
  const setTheme     = useUiStore((s) => s.setTheme);

  const analyticsConsent   = useSettingsStore((s) => s.analyticsConsent);
  const setConsent         = useSettingsStore((s) => s.setConsent);
  const profiles           = useSettingsStore((s) => s.structureProfiles);
  const saveProfile        = useSettingsStore((s) => s.saveProfile);
  const deleteProfile      = useSettingsStore((s) => s.deleteProfile);
  const hangar             = useSettingsStore((s) => s.hangar);
  const setHangarQty       = useSettingsStore((s) => s.setHangarQty);
  const bpcInventory       = useSettingsStore((s) => s.bpcInventory);
  const setBpcStockEntry   = useSettingsStore((s) => s.setBpcStockEntry);
  const blacklist          = useSettingsStore((s) => s.blacklist);
  const addBlacklist       = useSettingsStore((s) => s.addBlacklist);
  const removeBlacklist    = useSettingsStore((s) => s.removeBlacklist);
  const blueprintOverrides = useSettingsStore((s) => s.blueprintOverrides);
  const clearOverride      = useSettingsStore((s) => s.clearOverride);

  const marketRegions  = useMarketStore((s) => s.regions);
  const saveRegion     = useMarketStore((s) => s.saveRegion);
  const removeRegion   = useMarketStore((s) => s.removeRegion);

  const [editingProfile, setEditingProfile]   = useState<StructureProfile | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editingHub, setEditingHub]           = useState<MarketRegion | null>(null);
  const [confirmHubDeleteId, setConfirmHubDeleteId] = useState<string | null>(null);
  const [typeNames, setTypeNames]             = useState<Record<number, string>>({});
  const [optimizeForTime, setOptimizeForTime] = useState(false);

  useEffect(() => {
    getOptimizeDecryptersForTime().then(setOptimizeForTime).catch(() => {});
  }, []);

  async function handleToggleOptimizeForTime() {
    const next = !optimizeForTime;
    setOptimizeForTime(next); // optimistic
    try {
      await setOptimizeDecryptersForTime(next);
    } catch {
      setOptimizeForTime(!next); // revert on failure
    }
  }

  // Resolve type names for hangar, blacklist, and overrides whenever they change.
  useEffect(() => {
    const ids = [
      ...Object.keys(hangar).map(Number),
      ...Object.keys(bpcInventory).map(Number),
      ...blacklist,
      ...blueprintOverrides.map((o) => o.typeId),
    ];
    const unique = [...new Set(ids)];
    if (unique.length === 0) return;
    getTypeNames(unique).then(setTypeNames).catch(() => {});
  }, [hangar, bpcInventory, blacklist, blueprintOverrides]);

  async function handleSaveProfile(p: StructureProfile) {
    await saveProfile(p);
    setEditingProfile(null);
  }

  async function handleDeleteProfile(id: string) {
    await deleteProfile(id);
    setConfirmDeleteId(null);
  }

  function handlePickHangar(type: TypeSummary) {
    setHangarQty(type.typeId, 1);
  }

  function handlePickBpcStock(type: TypeSummary) {
    setBpcStockEntry(type.typeId, 0, 0, 1);
  }

  function handlePickBlacklist(type: TypeSummary) {
    addBlacklist(type.typeId);
  }

  async function handleSaveHub(hub: MarketRegion) {
    // Prevent duplicate hubs for the same region or structure.
    const duplicate = marketRegions.find(
      (r) => r.regionId === hub.regionId && r.id !== hub.id
    );
    if (duplicate) {
      alert(`"${duplicate.label}" already uses this hub. Remove it first or edit it instead.`);
      return;
    }
    await saveRegion(hub);
    setEditingHub(null);
  }

  // If we're editing a profile, show the editor full-panel.
  if (editingHub) {
    return (
      <MarketHubEditor
        initial={editingHub}
        onSave={handleSaveHub}
        onCancel={() => setEditingHub(null)}
      />
    );
  }

  if (editingProfile) {
    return (
      <ProfileEditor
        initial={editingProfile}
        onSave={handleSaveProfile}
        onCancel={() => setEditingProfile(null)}
      />
    );
  }

  const hangarEntries = Object.entries(hangar).map(([id, qty]) => ({
    typeId: Number(id),
    qty,
  }));

  const bpcStockEntries = Object.entries(bpcInventory).map(([id, entry]) => ({
    typeId: Number(id),
    ...entry,
  }));

  return (
    <div className="sp">

      {/* ── Theme ── */}
      <div className="sp-section">
        <div className="sp-section-title">Theme</div>
        <div className="sp-theme-grid">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`sp-theme-swatch${currentTheme === t.id ? " active" : ""}`}
              onClick={() => setTheme(t.id)}
              title={t.description}
            >
              <span
                className="sp-theme-preview"
                style={{ background: t.bg }}
              >
                <span
                  className="sp-theme-preview-bar"
                  style={{ background: t.accent }}
                />
              </span>
              <span className="sp-theme-label">{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Analytics ── */}
      <div className="sp-section">
        <div className="sp-section-title">Analytics</div>
        <div className="sp-analytics-row">
          <div className="sp-analytics-text">
            <span className="sp-analytics-label">Usage Telemetry</span>
            <span className="sp-analytics-desc">
              Anonymous launch pings help track active users. No personal data is sent.
            </span>
          </div>
          <button
            className={`sp-toggle${analyticsConsent === "Granted" ? " active" : ""}`}
            onClick={() => setConsent(analyticsConsent === "Granted" ? "Denied" : "Granted")}
            title={analyticsConsent === "Granted" ? "Disable telemetry" : "Enable telemetry"}
          >
            {analyticsConsent === "Granted" ? "On" : "Off"}
          </button>
        </div>
      </div>

      {/* ── Invention ── */}
      <div className="sp-section">
        <div className="sp-section-title">Invention</div>
        <div className="sp-analytics-row">
          <div className="sp-analytics-text">
            <span className="sp-analytics-label">Decrypter auto-pick: optimize for time</span>
            <span className="sp-analytics-desc">
              When picking a decrypter automatically, prefer whichever minimizes total job
              time (invention + manufacturing) instead of total ISK cost. Off by default. Has
              no effect where you've manually chosen a decrypter for an item.
            </span>
          </div>
          <button
            className={`sp-toggle${optimizeForTime ? " active" : ""}`}
            onClick={handleToggleOptimizeForTime}
            title={optimizeForTime ? "Switch back to cost optimization" : "Switch to time optimization"}
          >
            {optimizeForTime ? "Time" : "Cost"}
          </button>
        </div>
      </div>

      {/* ── Market hubs ── */}
      <div className="sp-section">
        <div className="sp-section-title-row">
          <div className="sp-section-title">Market Hubs</div>
          <button className="sp-new-profile-btn" onClick={() => setEditingHub(newHub())}>
            + Add
          </button>
        </div>
        <span className="sp-hint">
          Regions used for price lookups and profitability calculations. Jita is always included.
        </span>
        {marketRegions.length === 0 ? (
          <div className="sp-empty-note">No hubs configured.</div>
        ) : (
          <div className="sp-profile-list">
            {marketRegions.map((hub) => {
              const isConfirming = confirmHubDeleteId === hub.id;
              return (
                <div key={hub.id} className="sp-profile-row">
                  <div className="sp-profile-info">
                    <span className="sp-profile-name">{hub.label}</span>
                    <span className="sp-profile-meta">
                      Region {hub.regionId}
                      {hub.isDefault && " · Default"}
                      {hub.isLocal && " · Local"}
                    </span>
                  </div>
                  <div className="sp-row-actions">
                    {isConfirming ? (
                      <>
                        <span className="sp-confirm-label">Delete?</span>
                        <button className="sp-btn-sm sp-btn-danger" onClick={async () => { await removeRegion(hub.id); setConfirmHubDeleteId(null); }}>Yes</button>
                        <button className="sp-btn-sm" onClick={() => setConfirmHubDeleteId(null)}>No</button>
                      </>
                    ) : (
                      <>
                        <button className="sp-btn-sm" onClick={() => setEditingHub(hub)} title="Edit">✎</button>
                        {!hub.isDefault && (
                          <button className="sp-btn-sm sp-btn-remove" onClick={() => setConfirmHubDeleteId(hub.id)} title="Delete">×</button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Structure profiles ── */}
      <div className="sp-section">
        <div className="sp-section-title-row">
          <div className="sp-section-title">Structure Profiles</div>
          <button className="sp-new-profile-btn" onClick={() => setEditingProfile(newProfile())}>
            + New
          </button>
        </div>

        {profiles.length === 0 ? (
          <div className="sp-empty-note">
            No profiles yet. Create one to apply structure rigs and taxes to build cost calculations.
          </div>
        ) : (
          <div className="sp-profile-list">
            {profiles.map((p) => {
              const isConfirming = confirmDeleteId === p.id;
              return (
                <div key={p.id} className="sp-profile-row">
                  <div className="sp-profile-info">
                    <span className="sp-profile-name">{p.label}</span>
                    <span className="sp-profile-meta">
                      {p.jobType} · Tax {(p.facilityTax * 100).toFixed(1)}%
                      {(() => {
                        const rigCount = p.installedRigs.length > 0 ? p.installedRigs.length : p.rigBonuses.length;
                        return rigCount > 0 && ` · ${rigCount} rig${rigCount > 1 ? "s" : ""}`;
                      })()}
                    </span>
                    <ProfileCostBadge profile={p} />
                  </div>
                  <div className="sp-row-actions">
                    {isConfirming ? (
                      <>
                        <span className="sp-confirm-label">Delete?</span>
                        <button className="sp-btn-sm sp-btn-danger" onClick={() => handleDeleteProfile(p.id)}>Yes</button>
                        <button className="sp-btn-sm" onClick={() => setConfirmDeleteId(null)}>No</button>
                      </>
                    ) : (
                      <>
                        <button className="sp-btn-sm" onClick={() => setEditingProfile(p)} title="Edit">✎</button>
                        <button className="sp-btn-sm sp-btn-remove" onClick={() => setConfirmDeleteId(p.id)} title="Delete">×</button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Virtual hangar ── */}
      <div className="sp-section">
        <div className="sp-section-title">Virtual Hangar</div>
        <span className="sp-hint">
          Stock the solver knows you have on hand. Reduces what needs to be built or bought.
        </span>
        <TypePicker placeholder="Add item to hangar…" onSelect={handlePickHangar} />
        {hangarEntries.length === 0 ? (
          <div className="sp-empty-note">No hangar stock set.</div>
        ) : (
          <div className="sp-item-list">
            {hangarEntries.map(({ typeId, qty }) => (
              <div key={typeId} className="sp-item-row">
                <TypeIcon typeId={typeId} variant="icon" size={32} displaySize={18} alt="" />
                <span className="sp-item-name">{typeNames[typeId] ?? `#${typeId}`}</span>
                <input
                  className="sp-qty-input"
                  type="number"
                  min={0}
                  value={qty}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    setHangarQty(typeId, isNaN(v) ? 0 : v);
                  }}
                />
                <button
                  className="sp-btn-sm sp-btn-remove"
                  onClick={() => setHangarQty(typeId, 0)}
                  title="Remove"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── BPC stock ── */}
      <div className="sp-section">
        <div className="sp-section-title">BPC Stock</div>
        <span className="sp-hint">
          Already-invented BPCs you have on hand. The solver uses these runs before planning
          new invention attempts. Different from Blueprint Overrides below, which set ME/TE
          research levels for owned BPOs (unlimited runs) — this is finite-run BPC stock that
          gets consumed as it's used.
        </span>
        <TypePicker placeholder="Add BPC stock…" onSelect={handlePickBpcStock} />
        {bpcStockEntries.length === 0 ? (
          <div className="sp-empty-note">No BPC stock set.</div>
        ) : (
          <div className="sp-item-list">
            {bpcStockEntries.map(({ typeId, meLevel, teLevel, runsRemaining }) => (
              <div key={typeId} className="sp-item-row">
                <TypeIcon typeId={typeId} variant="icon" size={32} displaySize={18} alt="" />
                <span className="sp-item-name">{typeNames[typeId] ?? `#${typeId}`}</span>
                <label className="sp-bpc-field">
                  ME
                  <input
                    className="sp-qty-input sp-bpc-input"
                    type="number"
                    min={0}
                    max={10}
                    value={meLevel}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      setBpcStockEntry(typeId, isNaN(v) ? 0 : v, teLevel, runsRemaining);
                    }}
                  />
                </label>
                <label className="sp-bpc-field">
                  TE
                  <input
                    className="sp-qty-input sp-bpc-input"
                    type="number"
                    min={0}
                    max={20}
                    value={teLevel}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      setBpcStockEntry(typeId, meLevel, isNaN(v) ? 0 : v, runsRemaining);
                    }}
                  />
                </label>
                <label className="sp-bpc-field">
                  Runs
                  <input
                    className="sp-qty-input sp-bpc-input"
                    type="number"
                    min={0}
                    value={runsRemaining}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      setBpcStockEntry(typeId, meLevel, teLevel, isNaN(v) ? 0 : v);
                    }}
                  />
                </label>
                <button
                  className="sp-btn-sm sp-btn-remove"
                  onClick={() => setBpcStockEntry(typeId, meLevel, teLevel, 0)}
                  title="Remove"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Blacklist ── */}
      <div className="sp-section">
        <div className="sp-section-title">Always Buy</div>
        <span className="sp-hint">
          The solver will never build these items — always sources them by buying.
        </span>
        <TypePicker placeholder="Add item to blacklist…" onSelect={handlePickBlacklist} />
        {blacklist.length === 0 ? (
          <div className="sp-empty-note">No items blacklisted.</div>
        ) : (
          <div className="sp-item-list">
            {blacklist.map((typeId) => (
              <div key={typeId} className="sp-item-row">
                <TypeIcon typeId={typeId} variant="icon" size={32} displaySize={18} alt="" />
                <span className="sp-item-name">{typeNames[typeId] ?? `#${typeId}`}</span>
                <button
                  className="sp-btn-sm sp-btn-remove"
                  onClick={() => removeBlacklist(typeId)}
                  title="Remove"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Blueprint overrides ── */}
      <div className="sp-section">
        <div className="sp-section-title">Blueprint Overrides</div>
        <span className="sp-hint">
          ME/TE overrides set via the node detail panel. Clear one to revert to defaults.
        </span>
        {blueprintOverrides.length === 0 ? (
          <div className="sp-empty-note">No overrides saved.</div>
        ) : (
          <div className="sp-item-list">
            {blueprintOverrides.map((o) => (
              <div key={o.typeId} className="sp-item-row">
                <TypeIcon typeId={o.typeId} variant="icon" size={32} displaySize={18} alt="" />
                <span className="sp-item-name">{typeNames[o.typeId] ?? `#${o.typeId}`}</span>
                <span className="sp-override-badge">ME{o.meLevel}%</span>
                <span className="sp-override-badge">TE{o.teLevel}%</span>
                <button
                  className="sp-btn-sm sp-btn-remove"
                  onClick={() => clearOverride(o.typeId)}
                  title="Clear override"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Data folder ─────────────────────────────────────────────────────── */}
      <div className="sp-section">
        <div className="sp-section-title">App Data</div>
        <span className="sp-hint">
          Your plans, settings, and market cache are stored locally. Use this to back up or manually remove your data.
        </span>
        <button
          className="sp-btn-secondary"
          onClick={() => invoke("open_app_data_folder")}
          title="Open the folder where Eve Nexus stores your plans and settings"
        >
          Open Data Folder
        </button>
      </div>

    </div>
  );
}