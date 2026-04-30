import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore, useUiStore, useMarketStore } from "../../store";
import { getTypeNames, getSystemCostInfo, searchMarketStructures, getAssetStructures } from "../../api";
import { TypeIcon, TypePicker, SystemPicker, Select } from "../common";
import type { JobType, MarketRegion, RigBonus, StructureProfile, StructureSearchResult, SystemCostInfo, TypeSummary } from "../../api";
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

  function addRig() {
    setProfile((p) => ({
      ...p,
      rigBonuses: [...p.rigBonuses, { categoryId: 0, meBonus: 0, teBonus: 0 }],
    }));
  }

  function updateRig(i: number, patch: Partial<RigBonus>) {
    setProfile((p) => ({
      ...p,
      rigBonuses: p.rigBonuses.map((r, idx) => idx === i ? { ...r, ...patch } : r),
    }));
  }

  function removeRig(i: number) {
    setProfile((p) => ({
      ...p,
      rigBonuses: p.rigBonuses.filter((_, idx) => idx !== i),
    }));
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
            value={(profile.facilityTax * 100).toFixed(1)}
            onChange={(e) => setField("facilityTax", parseFloat(e.target.value) / 100 || 0)}
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
          value={profile.spaceModifier}
          onChange={(e) => setField("spaceModifier", parseFloat(e.target.value) || 1)}
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

      <div className="sp-field">
        <div className="sp-label-row">
          <label
            className="sp-label"
            title="Material Efficiency and Time Efficiency bonuses from structure rigs. In-game, navigate to the structure's Industry tab to see installed rigs and their bonuses. Bonuses are per item category (e.g. category 6 = Ships, 7 = Modules). T2 rigs give ~double the bonus of T1."
          >
            Rig Bonuses
          </label>
          <button className="sp-add-rig-btn" onClick={addRig}>+ Add</button>
        </div>
        {profile.rigBonuses.length === 0 ? (
          <div className="sp-rig-empty">
            No rigs — add ME/TE bonuses from the structure's installed rigs.
            <span className="sp-rig-empty-tip">
              Example: a Sotiyo with T2 Thukker Manufacturing Efficiency rigs gives
              4.2% ME for Ships (category 6).
            </span>
          </div>
        ) : (
          <div className="sp-rig-list">
            <div className="sp-rig-header">
              <span title="EVE item category ID. Common ones: 4=Material, 6=Ship, 7=Module, 8=Charge, 17=Commodity, 25=Asteroid. Check the SDE or EVE University wiki for others.">Category ID</span>
              <span title="Material Efficiency bonus in %. Reduces material requirements for items in this category. T1 Rigs ≈2%, T2 Rigs ≈4%.">ME %</span>
              <span title="Time Efficiency bonus in %. Reduces job duration for items in this category. T1 Rigs ≈2%, T2 Rigs ≈4%.">TE %</span>
              <span />
            </div>
            {profile.rigBonuses.map((rig, i) => (
              <div key={i} className="sp-rig-row">
                <input
                  className="sp-input sp-rig-input"
                  type="number"
                  min={0}
                  value={rig.categoryId}
                  onChange={(e) => updateRig(i, { categoryId: parseInt(e.target.value, 10) || 0 })}
                />
                <input
                  className="sp-input sp-rig-input"
                  type="number"
                  min={0}
                  max={25}
                  step={0.1}
                  value={rig.meBonus}
                  onChange={(e) => updateRig(i, { meBonus: parseFloat(e.target.value) || 0 })}
                />
                <input
                  className="sp-input sp-rig-input"
                  type="number"
                  min={0}
                  max={20}
                  step={0.1}
                  value={rig.teBonus}
                  onChange={(e) => updateRig(i, { teBonus: parseFloat(e.target.value) || 0 })}
                />
                <button className="sp-rig-remove" onClick={() => removeRig(i)} title="Remove rig">
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

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
  onSave: (r: MarketRegion) => void;
  onCancel: () => void;
}) {
  const isStructureInit = initial.structureId != null;
  const [hub, setHub]             = useState<MarketRegion>(initial);
  const [usePreset, setUsePreset] = useState(!isStructureInit);
  const [isStructure, setIsStructure] = useState(isStructureInit);

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
    function handle(e: MouseEvent) {
      if (structContainer.current && !structContainer.current.contains(e.target as Node)) {
        setStructOpen(false);
        if (selectedStructure) setStructQuery(selectedStructure.structureName);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
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

  function handleSave() {
    if (isStructure && selectedStructure) {
      const sid = selectedStructure.structureId;
      onSave({ ...hub, label: hub.label || selectedStructure.structureName, regionId: sid, structureId: sid });
    } else if (!isStructure) {
      onSave({ ...hub, structureId: undefined });
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

      <div className="sp-editor-actions">
        <button className="sp-btn-save" onClick={handleSave} disabled={!valid}>
          Save Hub
        </button>
        <button className="sp-btn-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function newHub(): MarketRegion {
  return { id: crypto.randomUUID(), label: "", regionId: 0, isDefault: false };
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

  // Resolve type names for hangar, blacklist, and overrides whenever they change.
  useEffect(() => {
    const ids = [
      ...Object.keys(hangar).map(Number),
      ...blacklist,
      ...blueprintOverrides.map((o) => o.typeId),
    ];
    const unique = [...new Set(ids)];
    if (unique.length === 0) return;
    getTypeNames(unique).then(setTypeNames).catch(() => {});
  }, [hangar, blacklist, blueprintOverrides]);

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
                      {p.rigBonuses.length > 0 && ` · ${p.rigBonuses.length} rig${p.rigBonuses.length > 1 ? "s" : ""}`}
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
