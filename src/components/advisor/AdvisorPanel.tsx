import { useEffect, useState, useCallback } from "react";
import { getIndustrySkills, getCharacterBlueprints, getTypeNames, getSystemCostInfo } from "../../api";
import { useSettingsStore } from "../../store";
import type { BlueprintOwnership, StructureProfile, SystemCostInfo, SystemSearchResult } from "../../api";
import { SystemPicker, SystemComparison } from "../common";
import "./AdvisorPanel.css";

// ── Skill definitions ─────────────────────────────────────────────────────────

interface SkillDef {
  typeId: number;
  name: string;
  group: "manufacturing" | "reaction" | "research" | "invention";
  /** One-line description of what each level gives. */
  perLevel: string;
  /** Optional tip shown once the skill hits L5. */
  maxNote?: string;
}

const SKILL_DEFS: SkillDef[] = [
  // Manufacturing time
  {
    typeId: 3380,
    name: "Industry",
    group: "manufacturing",
    perLevel: "-4% manufacturing job duration",
    maxNote: "Combine with Advanced Industry for -35% total.",
  },
  {
    typeId: 3388,
    name: "Advanced Industry",
    group: "manufacturing",
    perLevel: "-3% manufacturing job duration",
    maxNote: "At L5 with Industry L5: -35% total job time.",
  },
  // Manufacturing slots
  {
    typeId: 3387,
    name: "Mass Production",
    group: "manufacturing",
    perLevel: "+1 manufacturing job slot (up to 5 extra)",
  },
  {
    typeId: 24625,
    name: "Advanced Mass Production",
    group: "manufacturing",
    perLevel: "+1 manufacturing job slot (up to 5 extra, stacks with Mass Production)",
    maxNote: "At L5 with Mass Production L5: 11 simultaneous manufacturing jobs.",
  },
  {
    typeId: 24268,
    name: "Supply Chain Management",
    group: "manufacturing",
    perLevel: "+1 remote manufacturing distance (jumps)",
    maxNote: "Lets you submit jobs at stations up to 5 jumps away.",
  },
  // Reactions
  {
    typeId: 45746,
    name: "Reactions",
    group: "reaction",
    perLevel: "-4% reaction job duration",
    maxNote: "Stack with Mass Reactions + Advanced Mass Reactions for maximum throughput.",
  },
  {
    typeId: 45748,
    name: "Mass Reactions",
    group: "reaction",
    perLevel: "+1 reaction job slot (up to 5 extra)",
  },
  {
    typeId: 45749,
    name: "Advanced Mass Reactions",
    group: "reaction",
    perLevel: "+1 reaction job slot (up to 5 extra, stacks with Mass Reactions)",
    maxNote: "At L5 with Mass Reactions L5: 11 simultaneous reaction jobs.",
  },
  {
    typeId: 45750,
    name: "Remote Reactions",
    group: "reaction",
    perLevel: "+1 remote reaction distance (jumps)",
    maxNote: "Lets you submit reaction jobs at structures up to 5 jumps away.",
  },
  // Research / copying
  {
    typeId: 3402,
    name: "Science",
    group: "research",
    perLevel: "Prerequisite for most research and invention skills",
  },
  {
    typeId: 3403,
    name: "Research",
    group: "research",
    perLevel: "-5% ME/TE research job duration per level",
  },
  {
    typeId: 3409,
    name: "Metallurgy",
    group: "research",
    perLevel: "-5% ME research job duration per level",
  },
  {
    typeId: 3406,
    name: "Laboratory Operation",
    group: "research",
    perLevel: "+1 research/copy job slot",
  },
  {
    typeId: 24624,
    name: "Advanced Laboratory Operation",
    group: "research",
    perLevel: "+1 research/copy job slot (up to 5 extra)",
    maxNote: "At L5 with Lab Operation L5: 11 simultaneous research/copy/invention jobs.",
  },
  {
    typeId: 24270,
    name: "Scientific Networking",
    group: "research",
    perLevel: "+1 remote research distance (jumps)",
    maxNote: "Lets you submit research jobs at stations up to 5 jumps away.",
  },
  // Encryption methods
  { typeId: 21790, name: "Caldari Encryption Methods",   group: "invention", perLevel: "+2% invention chance (Caldari/Sleeper BPs)",    maxNote: "L5: +10% base invention probability." },
  { typeId: 21791, name: "Minmatar Encryption Methods",  group: "invention", perLevel: "+2% invention chance (Minmatar/Takmahl BPs)", maxNote: "L5: +10% base invention probability." },
  { typeId: 23087, name: "Amarr Encryption Methods",     group: "invention", perLevel: "+2% invention chance (Amarr/Talocan BPs)",    maxNote: "L5: +10% base invention probability." },
  { typeId: 23121, name: "Gallente Encryption Methods",  group: "invention", perLevel: "+2% invention chance (Gallente/Yan Jung BPs)", maxNote: "L5: +10% base invention probability." },
  { typeId:  3408, name: "Sleeper Encryption Methods",   group: "invention", perLevel: "+2% invention chance (Sleeper/Talocan BPs)",  maxNote: "L5: +10% base invention probability." },
  { typeId: 52308, name: "Triglavian Encryption Methods",group: "invention", perLevel: "+2% invention chance (Triglavian BPs)",       maxNote: "L5: +10% base invention probability." },
  { typeId: 55025, name: "Upwell Encryption Methods",    group: "invention", perLevel: "+2% invention chance (Upwell structure BPs)", maxNote: "L5: +10% base invention probability." },
  // Science skills (affect invention probability as secondary skills)
  { typeId: 11529, name: "Molecular Engineering",        group: "invention", perLevel: "+1% invention chance per level" },
  { typeId: 11449, name: "Rocket Science",               group: "invention", perLevel: "+1% invention chance per level" },
  { typeId: 11441, name: "Plasma Physics",               group: "invention", perLevel: "+1% invention chance per level" },
  { typeId: 11433, name: "High Energy Physics",          group: "invention", perLevel: "+1% invention chance per level" },
  { typeId: 11448, name: "Electromagnetic Physics",      group: "invention", perLevel: "+1% invention chance per level" },
  { typeId: 11443, name: "Hydromagnetic Physics",        group: "invention", perLevel: "+1% invention chance per level" },
  { typeId: 11447, name: "Laser Physics",                group: "invention", perLevel: "+1% invention chance per level" },
  { typeId: 11451, name: "Nuclear Physics",              group: "invention", perLevel: "+1% invention chance per level" },
  { typeId: 11452, name: "Mechanical Engineering",       group: "invention", perLevel: "+1% invention chance per level" },
  { typeId: 11453, name: "Electronic Engineering",       group: "invention", perLevel: "+1% invention chance per level" },
  { typeId: 11455, name: "Quantum Physics",              group: "invention", perLevel: "+1% invention chance per level" },
  { typeId: 11446, name: "Graviton Physics",             group: "invention", perLevel: "+1% invention chance per level" },
  { typeId: 11442, name: "Nanite Engineering",           group: "invention", perLevel: "+1% invention chance per level" },
  // Starship engineering
  { typeId: 11454, name: "Caldari Starship Engineering",  group: "invention", perLevel: "+1% invention chance per level (Caldari ships)" },
  { typeId: 11450, name: "Gallente Starship Engineering", group: "invention", perLevel: "+1% invention chance per level (Gallente ships)" },
  { typeId: 11444, name: "Amarr Starship Engineering",    group: "invention", perLevel: "+1% invention chance per level (Amarr ships)" },
  { typeId: 11445, name: "Minmatar Starship Engineering", group: "invention", perLevel: "+1% invention chance per level (Minmatar ships)" },
  { typeId: 81050, name: "Upwell Starship Engineering",   group: "invention", perLevel: "+1% invention chance per level (Upwell ships)" },
  // Subsystem / advanced
  { typeId: 30325, name: "Core Subsystem Technology",       group: "invention", perLevel: "+1% invention chance per level (T3 core subsystems)" },
  { typeId: 30324, name: "Defensive Subsystem Technology",  group: "invention", perLevel: "+1% invention chance per level (T3 defensive subsystems)" },
  { typeId: 30327, name: "Offensive Subsystem Technology",  group: "invention", perLevel: "+1% invention chance per level (T3 offensive subsystems)" },
  { typeId: 30788, name: "Propulsion Subsystem Technology", group: "invention", perLevel: "+1% invention chance per level (T3 propulsion subsystems)" },
  { typeId: 52307, name: "Triglavian Quantum Engineering",  group: "invention", perLevel: "+1% invention chance per level (Triglavian hulls)" },
  { typeId:  3400, name: "Outpost Construction",            group: "invention", perLevel: "+1% invention chance per level" },
  { typeId: 22242, name: "Capital Ship Construction",       group: "invention", perLevel: "+1% invention chance per level (capital hulls)" },
];

const GROUP_LABELS: Record<SkillDef["group"], string> = {
  manufacturing: "Manufacturing",
  reaction: "Reactions",
  research: "Research & Copying",
  invention: "Invention",
};

// ── Structure tips ────────────────────────────────────────────────────────────

const STRUCTURE_TIPS = [
  {
    title: "Use an Engineering Complex or Citadel",
    body: "Manufacturing in an Azbel, Sotiyo, or Raitaru with T1/T2 Material Efficiency rigs gives a 2–4% material reduction — NPC stations give 0%.",
  },
  {
    title: "Null-sec structures have the best material bonuses",
    body: "T2 Thukker Component Assembly Array rigs in a null-sec Sotiyo give up to 4.2% ME, the maximum in the game for capital/sub-capital manufacturing.",
  },
  {
    title: "Match structure type to job type",
    body: "Azbel/Sotiyo for T2/capital manufacturing. Tatara/Athanor for reactions. Research arrays are best for ME/TE research and invention.",
  },
  {
    title: "System cost index matters more than you think",
    body: "Job cost = estimated output value × cost index × facility tax. Moving production from a 5% index system to a 0.3% one can cut job costs by 90%.",
  },
  {
    title: "Blueprint ME research pays for itself quickly",
    body: "Each ME level above 0 saves roughly 0.5–1% of material costs per job. For high-volume builds, ME10 vs ME0 can save hundreds of millions per day.",
  },
];

// ── Structure profile quick-edit row ──────────────────────────────────────────

interface ProfileRowProps {
  profile: StructureProfile;
  onSave: (updated: StructureProfile) => void;
}

function ProfileSystemRow({ profile, onSave }: ProfileRowProps) {
  const [info, setInfo]       = useState<SystemCostInfo | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!profile.solarSystemId) { setInfo(null); return; }
    getSystemCostInfo(profile.solarSystemId).then(setInfo).catch(() => {});
  }, [profile.solarSystemId]);

  const idx       = info ? (profile.jobType === "Reaction" ? info.reaction : info.manufacturing) : null;
  const effective = idx !== null ? idx * profile.spaceModifier : null;
  const isHigh    = effective !== null && effective > 0.05;

  function handleSelect(s: SystemSearchResult) {
    onSave({ ...profile, solarSystemId: s.systemId });
    setEditing(false);
  }

  return (
    <div className="adv-profile-row">
      <div className="adv-profile-identity">
        <span className="adv-profile-name">{profile.label}</span>
        <span className="adv-profile-type">{profile.jobType}</span>
      </div>

      {editing ? (
        <div className="adv-profile-picker">
          <SystemPicker
            placeholder="Search solar system…"
            currentName={info?.systemName ?? null}
            onSelect={handleSelect}
          />
          <button className="adv-profile-cancel" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="adv-profile-system">
          {info ? (
            <span
              className={`adv-profile-idx${isHigh ? " high" : ""}`}
              title={`Raw index: ${(idx! * 100).toFixed(2)}%${profile.spaceModifier !== 1 ? ` · After ${profile.spaceModifier}× modifier: ${(effective! * 100).toFixed(2)}%` : ""}`}
            >
              {info.systemName} · {(effective! * 100).toFixed(2)}%
              {isHigh && <span className="adv-profile-warn"> ▲</span>}
            </span>
          ) : (
            <span className="adv-profile-nosystem">No system set</span>
          )}
          <button
            className="adv-profile-change-btn"
            onClick={() => setEditing(true)}
            title={profile.solarSystemId ? "Change the solar system for this structure" : "Set the solar system to enable cost index calculations"}
          >
            {profile.solarSystemId ? "Change" : "Set system"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

function Stars({ level, max = 5 }: { level: number; max?: number }) {
  return (
    <span className="adv-stars" aria-label={`Level ${level} of ${max}`}>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={i < level ? "adv-star filled" : "adv-star"}>
          ★
        </span>
      ))}
    </span>
  );
}

export function AdvisorPanel() {
  const profiles     = useSettingsStore((s) => s.structureProfiles);
  const saveProfile  = useSettingsStore((s) => s.saveProfile);

  const [skills, setSkills]       = useState<Record<number, number>>({});
  const [bps, setBps]             = useState<BlueprintOwnership[]>([]);
  const [typeNames, setTypeNames] = useState<Record<number, string>>({});
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, b] = await Promise.all([getIndustrySkills(), getCharacterBlueprints()]);
      setSkills(s);
      setBps(b);
      // Resolve type names for any BPOs below ME10
      const lowIds = [...new Set(
        b.filter((bp) => bp.runs === -1 && bp.meLevel < 10).map((bp) => bp.blueprintTypeId)
      )];
      if (lowIds.length > 0) {
        setTypeNames(await getTypeNames(lowIds));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // BPOs (runs === -1) with ME < 10, grouped by typeId keeping best ME per blueprint
  const lowMeBpos = (() => {
    const bestMe = new Map<number, number>();
    for (const bp of bps) {
      if (bp.runs !== -1) continue; // only BPOs
      const cur = bestMe.get(bp.blueprintTypeId) ?? -1;
      if (bp.meLevel > cur) bestMe.set(bp.blueprintTypeId, bp.meLevel);
    }
    return [...bestMe.entries()]
      .filter(([, me]) => me < 10)
      .sort((a, b) => a[1] - b[1]); // lowest ME first
  })();

  const hasNoProfiles = profiles.length === 0;

  const groups = (["manufacturing", "reaction", "research", "invention"] as const)
    .map((g) => ({ group: g, defs: SKILL_DEFS.filter((d) => d.group === g) }));

  if (loading) {
    return <div className="adv-state">Loading advisor…</div>;
  }

  if (error) {
    return (
      <div className="adv-state adv-error">
        <span>Could not load advisor data</span>
        <span className="adv-error-detail">{error}</span>
        <button className="adv-retry" onClick={load}>Retry</button>
      </div>
    );
  }

  return (
    <div className="adv">
      <div className="adv-scroll">

        {/* ── Structure tips (shown prominently when no profiles set) ── */}
        {hasNoProfiles && (
          <div className="adv-alert">
            <span className="adv-alert-icon">⚠</span>
            <div>
              <strong>No structure profiles configured.</strong> The solver is
              calculating jobs at NPC station rates (0% material bonus, default
              tax). Add a structure profile in Settings to model your actual
              manufacturing location.
            </div>
          </div>
        )}

        {/* ── Structure profiles quick-edit ── */}
        <section className="adv-section">
          <h3 className="adv-section-title">Structure Profiles</h3>
          {profiles.length === 0 ? (
            <p className="adv-section-intro">
              No profiles configured — add one in Settings to apply structure bonuses and cost indices to your builds.
            </p>
          ) : (
            <>
              <p className="adv-section-intro">
                Set the solar system for each profile to enable accurate job cost calculations.
                Lower cost index = cheaper installation fees. Values above 5% are flagged.
              </p>
              <div className="adv-profile-list">
                {profiles.map((p) => (
                  <ProfileSystemRow key={p.id} profile={p} onSave={saveProfile} />
                ))}
              </div>
            </>
          )}
        </section>

        {/* ── System cost index comparison ── */}
        <section className="adv-section">
          <h3 className="adv-section-title">System Comparison</h3>
          <p className="adv-section-intro">
            Track solar systems to compare manufacturing cost indices and market hub prices side by side.
            Green = cheap index, yellow = above 5%. The same list drives hub pricing in the Market tab.
          </p>
          <SystemComparison />
        </section>

        {/* ── Throughput capacity summary ── */}
        <section className="adv-section">
          <h3 className="adv-section-title">Your Job Capacity</h3>
          <p className="adv-section-intro">
            Slots are the hardest limit on your production rate — each idle slot
            is throughput you can never get back. Train slot skills first, then
            time-reduction skills to fit more batches per day.
          </p>
          <div className="adv-capacity-grid">
            {[
              {
                label:  "Manufacturing",
                max:    1 + Math.min(skills[3387] ?? 0, 5) + Math.min(skills[24625] ?? 0, 5),
                train:  "Mass Production + Advanced Mass Production",
                tip:    "1 base + Mass Production + Advanced Mass Production. At both L5: 11 simultaneous manufacturing jobs.",
              },
              {
                label:  "Reactions",
                max:    1 + Math.min(skills[45748] ?? 0, 5) + Math.min(skills[45749] ?? 0, 5),
                train:  "Mass Reactions + Advanced Mass Reactions",
                tip:    "1 base + Mass Reactions + Advanced Mass Reactions. At both L5: 11 simultaneous reaction jobs.",
              },
              {
                label:  "Research / Inv",
                max:    1 + Math.min(skills[3406] ?? 0, 5) + Math.min(skills[24624] ?? 0, 5),
                train:  "Lab Operation + Advanced Lab Operation",
                tip:    "1 base + Lab Operation + Advanced Lab Operation. At both L5: 11 simultaneous research/copy/invention jobs.",
              },
            ].map(({ label, max, train, tip }) => {
              const hardMax = 11;
              const isMaxed = max >= hardMax;
              return (
                <div key={label} className="adv-capacity-cell" title={tip}>
                  <span className="adv-cap-value">{max}</span>
                  <span className="adv-cap-label">{label}</span>
                  <div className="adv-cap-bar-wrap">
                    <div
                      className={`adv-cap-bar${isMaxed ? " maxed" : ""}`}
                      style={{ width: `${(max / hardMax) * 100}%` }}
                    />
                  </div>
                  {!isMaxed && (
                    <span className="adv-cap-train">Train {train} → {hardMax} max</span>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* ── Skills sections ── */}
        {groups.map(({ group, defs }) => (
          <section key={group} className="adv-section">
            <h3 className="adv-section-title">{GROUP_LABELS[group]}</h3>
            <div className="adv-skill-list">
              {defs.map((def) => {
                const level = skills[def.typeId] ?? 0;
                const isMaxed = level >= 5;
                return (
                  <div key={def.typeId} className={`adv-skill-row${isMaxed ? " maxed" : ""}`}>
                    <div className="adv-skill-name">{def.name}</div>
                    <Stars level={level} />
                    <div className="adv-skill-level">
                      {level === 0 ? "Not trained" : `Level ${level}`}
                    </div>
                    <div className="adv-skill-desc">
                      {isMaxed && def.maxNote ? def.maxNote : def.perLevel}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}

        {/* ── Blueprint research backlog ── */}
        {lowMeBpos.length > 0 && (
          <section className="adv-section">
            <h3 className="adv-section-title">Blueprint Research Backlog</h3>
            <p className="adv-section-intro">
              These BPOs are below ME10. Each ME level saves roughly 0.5–1% of
              material cost per run — research them when slots are free.
            </p>
            <div className="adv-bp-list">
              {lowMeBpos.slice(0, 20).map(([typeId, me]) => (
                <div key={typeId} className="adv-bp-row">
                  <span className="adv-bp-name">
                    {typeNames[typeId] ?? `#${typeId}`}
                  </span>
                  <div className="adv-bp-bar-wrap">
                    <div
                      className="adv-bp-bar"
                      style={{ width: `${(me / 10) * 100}%` }}
                    />
                  </div>
                  <span className="adv-bp-me">ME {me} / 10</span>
                </div>
              ))}
              {lowMeBpos.length > 20 && (
                <div className="adv-bp-more">
                  +{lowMeBpos.length - 20} more BPOs below ME10
                </div>
              )}
            </div>
          </section>
        )}

        {/* ── Structure & game mechanics tips ── */}
        <section className="adv-section">
          <h3 className="adv-section-title">Structure & Cost Tips</h3>
          <div className="adv-tip-list">
            {STRUCTURE_TIPS.map((tip) => (
              <div key={tip.title} className="adv-tip">
                <div className="adv-tip-title">{tip.title}</div>
                <div className="adv-tip-body">{tip.body}</div>
              </div>
            ))}
          </div>
        </section>

      </div>
    </div>
  );
}
