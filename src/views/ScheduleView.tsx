// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useRef, useState } from "react";
import { usePlanStore, useSettingsStore } from "../store";
import { computeSchedule } from "../api";
import { buildSolveRequest } from "../lib/solveRequest";
import { fmtDuration, esiErrorMessage } from "../lib/format";
import { copyText } from "../lib/export";
import type { ManufacturingJob, PlanSchedule } from "../api";
import "./ScheduleView.css";

// ── Math helpers ──────────────────────────────────────────────────────────────

function ceilDiv(n: number, d: number): number {
  if (d <= 0 || n <= 0) return 0;
  return Math.ceil(n / d);
}

// Total slot-seconds for an activity = Σ(runs × time_per_run)
function totalSlotSeconds(jobs: { runs?: number; attempts?: number; timePerRunSeconds?: number; timePerAttemptSeconds?: number }[]): number {
  return jobs.reduce((sum, j) => {
    const runs = j.runs ?? j.attempts ?? 0;
    const time = j.timePerRunSeconds ?? j.timePerAttemptSeconds ?? 0;
    return sum + runs * time;
  }, 0);
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ScheduleView() {
  const targets          = usePlanStore((s) => s.targets);
  const effectiveMult    = usePlanStore((s) => s.effectiveMultiplier);
  const blueprintOverrides = useSettingsStore((s) => s.blueprintOverrides);
  const structureProfiles  = useSettingsStore((s) => s.structureProfiles);
  const manualDecisions    = useSettingsStore((s) => s.manualDecisions);
  const blacklist          = useSettingsStore((s) => s.blacklist);
  const decrypterChoices   = useSettingsStore((s) => s.decrypterChoices);

  const [schedule, setSchedule]   = useState<PlanSchedule | null>(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [stale, setStale]         = useState(false);

  // Slot inputs
  const [industrySlots, setIndustrySlots] = useState(1);
  const [scienceSlots, setScienceSlots]   = useState(1);
  const [reactionSlots, setReactionSlots] = useState(1);

  // Reverse "what-if" inputs: how many days the user wants to finish by
  const [targetMfgInput, setTargetMfgInput] = useState("");
  const [targetInvInput, setTargetInvInput] = useState("");
  const [targetReactInput, setTargetReactInput] = useState("");

  // Per-row "Copied!" feedback
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  function handleCopyRow(key: string, text: string) {
    copyText(text).then(() => {
      setCopiedKey(key);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedKey(null), 1500);
    });
  }

  // ── Fetch ───────────────────────────────────────────────────────────────────

  function refreshSchedule() {
    if (targets.length === 0) return;
    setLoading(true);
    setError(null);
    setStale(false);
    const request = buildSolveRequest(targets, blueprintOverrides, structureProfiles, manualDecisions, blacklist, decrypterChoices, effectiveMult);
    // Pass current slot state to backend; we'll re-derive client-side from per-job data anyway.
    computeSchedule(request, industrySlots, scienceSlots)
      .then((s) => {
        setSchedule(s);
        // Seed slot inputs from character skills on first load.
        setIndustrySlots(Math.max(1, s.derivedIndustrySlots));
        setScienceSlots(Math.max(1, s.derivedScienceSlots));
        setReactionSlots(Math.max(1, s.derivedReactionSlots));
      })
      .catch((e) => setError(esiErrorMessage(e)))
      .finally(() => setLoading(false));
  }

  // Auto-fetch when view mounts, or mark stale when targets or any input that
  // feeds the solve request (decrypter choices, overrides, profiles, blacklist)
  // change after initial load — otherwise the displayed schedule silently goes
  // out of sync with those settings.
  useEffect(() => {
    if (schedule) { setStale(true); return; }
    refreshSchedule();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets, blueprintOverrides, structureProfiles, manualDecisions, blacklist, decrypterChoices]);

  // ── Derived totals (client-side math, no backend round-trip) ───────────────

  const totalMfgSecs = useMemo(
    () => totalSlotSeconds(schedule?.manufacturing ?? []),
    [schedule]
  );
  const totalReactSecs = useMemo(
    () => totalSlotSeconds(schedule?.reactions ?? []),
    [schedule]
  );
  const totalInvSecs = useMemo(
    () => totalSlotSeconds(schedule?.invention ?? []),
    [schedule]
  );

  // Forward: current slots → wall-clock time
  const mfgWallClock  = ceilDiv(totalMfgSecs, industrySlots);
  const invWallClock  = ceilDiv(totalInvSecs, scienceSlots);
  const reactWallClock = ceilDiv(totalReactSecs, reactionSlots);
  const criticalPath  = Math.max(mfgWallClock, invWallClock, reactWallClock);
  const bottleneck    =
    criticalPath === mfgWallClock ? "Manufacturing"
    : criticalPath === reactWallClock ? "Reactions"
    : "Invention";

  // Reverse: target days input → required slots
  const targetMfgDays = parseFloat(targetMfgInput);
  const targetInvDays = parseFloat(targetInvInput);
  const targetReactDays = parseFloat(targetReactInput);
  const reqIndustrySlots = !isNaN(targetMfgDays) && targetMfgDays > 0
    ? ceilDiv(totalMfgSecs, Math.round(targetMfgDays * 86400))
    : null;
  const reqReactionSlots = !isNaN(targetReactDays) && targetReactDays > 0
    ? ceilDiv(totalReactSecs, Math.round(targetReactDays * 86400))
    : null;
  const reqScienceSlots = !isNaN(targetInvDays) && targetInvDays > 0
    ? ceilDiv(totalInvSecs, Math.round(targetInvDays * 86400))
    : null;

  // ── Render ──────────────────────────────────────────────────────────────────

  if (targets.length === 0) {
    return (
      <div className="schedule-empty">
        Add build targets to compute a schedule.
      </div>
    );
  }

  if (loading) {
    return <div className="schedule-loading">Computing schedule…</div>;
  }

  if (error) {
    return (
      <div className="schedule-error">
        <span>Failed to compute schedule: {error}</span>
        <button onClick={refreshSchedule}>Retry</button>
      </div>
    );
  }

  if (!schedule) return null;

  const hasMfg = schedule.manufacturing.length > 0;
  const hasInv = schedule.invention.length > 0;
  const hasReact = schedule.reactions.length > 0;
  // Only job types present in the plan compete for the critical path.
  const activeWallClocks = [
    hasMfg && mfgWallClock, hasReact && reactWallClock, hasInv && invWallClock,
  ].filter((t): t is number => t !== false);
  const multiType = activeWallClocks.length > 1;
  const balanced = activeWallClocks.every((t) => t === criticalPath);

  return (
    <div className="schedule-view">
      {stale && (
        <div className="schedule-stale">
          Targets changed.
          <button className="schedule-refresh-btn" onClick={refreshSchedule}>Refresh</button>
        </div>
      )}

      {/* ── Manufacturing ─────────────────────────────────────────────────── */}
      {hasMfg && (
        <RunJobsSection
          title="Manufacturing"
          slotLabel="Industry slots"
          keyPrefix="mfg"
          jobs={schedule.manufacturing}
          slots={industrySlots}
          setSlots={setIndustrySlots}
          derivedSlots={schedule.derivedIndustrySlots}
          wallClock={mfgWallClock}
          targetInput={targetMfgInput}
          setTargetInput={setTargetMfgInput}
          reqSlots={reqIndustrySlots}
          copiedKey={copiedKey}
          onCopy={handleCopyRow}
        />
      )}

      {/* ── Reactions ─────────────────────────────────────────────────────── */}
      {hasReact && (
        <RunJobsSection
          title="Reactions"
          slotLabel="Reaction slots"
          keyPrefix="react"
          jobs={schedule.reactions}
          slots={reactionSlots}
          setSlots={setReactionSlots}
          derivedSlots={schedule.derivedReactionSlots}
          wallClock={reactWallClock}
          targetInput={targetReactInput}
          setTargetInput={setTargetReactInput}
          reqSlots={reqReactionSlots}
          copiedKey={copiedKey}
          onCopy={handleCopyRow}
        />
      )}

      {/* ── Invention ─────────────────────────────────────────────────────── */}
      {hasInv && (
        <section className="schedule-section">
          <h3 className="schedule-section-title">Invention</h3>

          <div className="schedule-slots-row">
            <div className="schedule-slot-group">
              <label className="schedule-label">Science slots</label>
              <input
                className="schedule-slots-input"
                type="number"
                min={1}
                max={99}
                value={scienceSlots}
                onChange={(e) => setScienceSlots(Math.max(1, parseInt(e.target.value) || 1))}
              />
              <span className="schedule-arrow">→</span>
              <span className="schedule-result">{fmtDuration(invWallClock)}</span>
              {schedule.derivedScienceSlots > 0 && scienceSlots !== schedule.derivedScienceSlots && (
                <button
                  className="schedule-reset-btn"
                  title={`Reset to skill-derived value (${schedule.derivedScienceSlots})`}
                  onClick={() => setScienceSlots(schedule.derivedScienceSlots)}
                >
                  {schedule.derivedScienceSlots} from skills
                </button>
              )}
            </div>

            <div className="schedule-slot-group schedule-reverse">
              <label className="schedule-label">Finish in</label>
              <input
                className="schedule-slots-input schedule-target-input"
                type="number"
                min={0.1}
                step={0.5}
                value={targetInvInput}
                onChange={(e) => setTargetInvInput(e.target.value)}
              />
              <span className="schedule-label-unit">days</span>
              <span className="schedule-arrow">→</span>
              <span className="schedule-result">
                {reqScienceSlots !== null
                  ? `${reqScienceSlots} slot${reqScienceSlots !== 1 ? "s" : ""}`
                  : "—"}
              </span>
              {reqScienceSlots !== null && reqScienceSlots !== scienceSlots && (
                <button
                  className="schedule-apply-btn"
                  onClick={() => setScienceSlots(reqScienceSlots)}
                >
                  Apply
                </button>
              )}
            </div>
          </div>

          <table className="schedule-jobs-table">
            <colgroup>
              <col />
              <col className="schedule-col-num" />
              <col className="schedule-col-num" />
              <col className="schedule-col-num" />
              <col className="schedule-col-num" />
              <col className="schedule-col-num" />
              <col className="schedule-col-num" />
            </colgroup>
            <thead>
              <tr>
                <th>Item</th>
                <th className="schedule-num">Attempts</th>
                <th className="schedule-num">Probability</th>
                <th className="schedule-num">Exp. BPCs</th>
                <th className="schedule-num">Time / attempt</th>
                <th className="schedule-num">Total work</th>
                <th className="schedule-num"></th>
              </tr>
            </thead>
            <tbody>
              {schedule.invention.map((j) => {
                const key = `inv-${j.typeId}`;
                const typeName = j.typeName.replace(" (Invention)", "");
                const nameKey = `inv-name-${j.typeId}`;
                return (
                  <tr key={j.typeId}>
                    <td>
                      <span className="schedule-name-cell">
                        <button
                          className="schedule-name-copy-btn"
                          title="Copy item name"
                          onClick={() => handleCopyRow(nameKey, typeName)}
                        >
                          {copiedKey === nameKey ? (
                            <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.6">
                              <polyline points="3,8.5 6.5,12 13,4.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          ) : (
                            <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.3">
                              <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
                              <path d="M3.5 10.5v-7a1 1 0 0 1 1-1h7" />
                            </svg>
                          )}
                        </button>
                        {typeName}
                      </span>
                    </td>
                    <td className="schedule-num">{j.attempts.toLocaleString()}</td>
                    <td className="schedule-num">{(j.probability * 100).toFixed(1)}%</td>
                    <td className="schedule-num">{j.expectedBpcs.toFixed(1)}</td>
                    <td className="schedule-num">{fmtDuration(j.timePerAttemptSeconds)}</td>
                    <td className="schedule-num">{fmtDuration(j.attempts * j.timePerAttemptSeconds)}</td>
                    <td className="schedule-num">
                      <button
                        className="schedule-row-copy-btn"
                        title="Copy this row as tab-separated text"
                        onClick={() =>
                          handleCopyRow(
                            key,
                            `${typeName}\t${j.attempts}\t${(j.probability * 100).toFixed(1)}%\t${j.expectedBpcs.toFixed(1)}\t${fmtDuration(j.timePerAttemptSeconds)}\t${fmtDuration(j.attempts * j.timePerAttemptSeconds)}`,
                          )
                        }
                      >
                        {copiedKey === key ? "Copied!" : "Copy"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {/* ── Critical path ─────────────────────────────────────────────────── */}
      {(hasMfg || hasReact || hasInv) && (
        <section className="schedule-critical">
          <span className="schedule-critical-label">Critical path</span>
          <span className="schedule-critical-time">{fmtDuration(criticalPath)}</span>
          {multiType && (
            <span className="schedule-bottleneck">
              {balanced ? "balanced" : `${bottleneck} is the bottleneck`}
            </span>
          )}
          {multiType && !balanced && (
            <span className="schedule-overlap-note">
              Each job type uses its own slots, so they run concurrently.
            </span>
          )}
        </section>
      )}

      {!hasMfg && !hasReact && !hasInv && (
        <div className="schedule-empty">
          No industry jobs in this plan. Solve the plan first, or all items are sourced by buying.
        </div>
      )}
    </div>
  );
}

// ── Run-based job section (manufacturing, reactions) ─────────────────────────

interface RunJobsSectionProps {
  title: string;
  slotLabel: string;
  keyPrefix: string;
  jobs: ManufacturingJob[];
  slots: number;
  setSlots: (n: number) => void;
  derivedSlots: number;
  wallClock: number;
  targetInput: string;
  setTargetInput: (v: string) => void;
  reqSlots: number | null;
  copiedKey: string | null;
  onCopy: (key: string, text: string) => void;
}

function RunJobsSection({
  title, slotLabel, keyPrefix, jobs, slots, setSlots, derivedSlots, wallClock,
  targetInput, setTargetInput, reqSlots, copiedKey, onCopy,
}: RunJobsSectionProps) {
  return (
    <section className="schedule-section">
      <h3 className="schedule-section-title">{title}</h3>

      <div className="schedule-slots-row">
        <div className="schedule-slot-group">
          <label className="schedule-label">{slotLabel}</label>
          <input
            className="schedule-slots-input"
            type="number"
            min={1}
            max={99}
            value={slots}
            onChange={(e) => setSlots(Math.max(1, parseInt(e.target.value) || 1))}
          />
          <span className="schedule-arrow">→</span>
          <span className="schedule-result">{fmtDuration(wallClock)}</span>
          {derivedSlots > 0 && slots !== derivedSlots && (
            <button
              className="schedule-reset-btn"
              title={`Reset to skill-derived value (${derivedSlots})`}
              onClick={() => setSlots(derivedSlots)}
            >
              {derivedSlots} from skills
            </button>
          )}
        </div>

        <div className="schedule-slot-group schedule-reverse">
          <label className="schedule-label">Finish in</label>
          <input
            className="schedule-slots-input schedule-target-input"
            type="number"
            min={0.1}
            step={0.5}
            value={targetInput}
            onChange={(e) => setTargetInput(e.target.value)}
          />
          <span className="schedule-label-unit">days</span>
          <span className="schedule-arrow">→</span>
          <span className="schedule-result">
            {reqSlots !== null
              ? `${reqSlots} slot${reqSlots !== 1 ? "s" : ""}`
              : "—"}
          </span>
          {reqSlots !== null && reqSlots !== slots && (
            <button
              className="schedule-apply-btn"
              onClick={() => setSlots(reqSlots)}
            >
              Apply
            </button>
          )}
        </div>
      </div>

      <table className="schedule-jobs-table">
        <colgroup>
          <col />
          <col className="schedule-col-num" />
          <col className="schedule-col-num" />
          <col className="schedule-col-num" />
          <col className="schedule-col-num" />
        </colgroup>
        <thead>
          <tr>
            <th>Item</th>
            <th className="schedule-num">Runs</th>
            <th className="schedule-num">Time / run</th>
            <th className="schedule-num">Total work</th>
            <th className="schedule-num"></th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => {
            const key = `${keyPrefix}-${j.typeId}`;
            const nameKey = `${keyPrefix}-name-${j.typeId}`;
            return (
              <tr key={j.typeId}>
                <td>
                  <span className="schedule-name-cell">
                    <button
                      className="schedule-name-copy-btn"
                      title="Copy item name"
                      onClick={() => onCopy(nameKey, j.typeName)}
                    >
                      {copiedKey === nameKey ? (
                        <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.6">
                          <polyline points="3,8.5 6.5,12 13,4.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.3">
                          <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
                          <path d="M3.5 10.5v-7a1 1 0 0 1 1-1h7" />
                        </svg>
                      )}
                    </button>
                    {j.typeName}
                  </span>
                </td>
                <td className="schedule-num">{j.runs.toLocaleString()}</td>
                <td className="schedule-num">{fmtDuration(j.timePerRunSeconds)}</td>
                <td className="schedule-num">{fmtDuration(j.runs * j.timePerRunSeconds)}</td>
                <td className="schedule-num">
                  <button
                    className="schedule-row-copy-btn"
                    title="Copy this row as tab-separated text"
                    onClick={() =>
                      onCopy(
                        key,
                        `${j.typeName}\t${j.runs}\t${fmtDuration(j.timePerRunSeconds)}\t${fmtDuration(j.runs * j.timePerRunSeconds)}`,
                      )
                    }
                  >
                    {copiedKey === key ? "Copied!" : "Copy"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
