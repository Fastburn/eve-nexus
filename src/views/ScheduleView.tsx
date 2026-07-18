// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useState } from "react";
import { usePlanStore, useSettingsStore } from "../store";
import { computeSchedule } from "../api";
import { buildSolveRequest } from "../lib/solveRequest";
import { fmtDuration } from "../lib/format";
import type { PlanSchedule } from "../api";
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

  // Reverse "what-if" inputs: how many days the user wants to finish by
  const [targetMfgInput, setTargetMfgInput] = useState("");
  const [targetInvInput, setTargetInvInput] = useState("");

  // ── Fetch ───────────────────────────────────────────────────────────────────

  function fetch() {
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
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }

  // Auto-fetch when view mounts, or mark stale when targets or any input that
  // feeds the solve request (decrypter choices, overrides, profiles, blacklist)
  // change after initial load — otherwise the displayed schedule silently goes
  // out of sync with those settings.
  useEffect(() => {
    if (schedule) { setStale(true); return; }
    fetch();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets, blueprintOverrides, structureProfiles, manualDecisions, blacklist, decrypterChoices]);

  useEffect(() => {
    if (!schedule) fetch();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Derived totals (client-side math, no backend round-trip) ───────────────

  const totalMfgSecs = useMemo(
    () => totalSlotSeconds(schedule?.manufacturing ?? []),
    [schedule]
  );
  const totalInvSecs = useMemo(
    () => totalSlotSeconds(schedule?.invention ?? []),
    [schedule]
  );

  // Forward: current slots → wall-clock time
  const mfgWallClock  = ceilDiv(totalMfgSecs, industrySlots);
  const invWallClock  = ceilDiv(totalInvSecs, scienceSlots);
  const criticalPath  = Math.max(mfgWallClock, invWallClock);
  const bottleneck    = mfgWallClock >= invWallClock ? "Manufacturing" : "Invention";
  const balanced      = mfgWallClock === invWallClock;

  // Reverse: target days input → required slots
  const targetMfgDays = parseFloat(targetMfgInput);
  const targetInvDays = parseFloat(targetInvInput);
  const reqIndustrySlots = !isNaN(targetMfgDays) && targetMfgDays > 0
    ? ceilDiv(totalMfgSecs, Math.round(targetMfgDays * 86400))
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
        <button onClick={fetch}>Retry</button>
      </div>
    );
  }

  if (!schedule) return null;

  const hasMfg = schedule.manufacturing.length > 0;
  const hasInv = schedule.invention.length > 0;

  return (
    <div className="schedule-view">
      {stale && (
        <div className="schedule-stale">
          Targets changed.
          <button className="schedule-refresh-btn" onClick={fetch}>Refresh</button>
        </div>
      )}

      {/* ── Manufacturing ─────────────────────────────────────────────────── */}
      {hasMfg && (
        <section className="schedule-section">
          <h3 className="schedule-section-title">Manufacturing</h3>

          <div className="schedule-slots-row">
            <div className="schedule-slot-group">
              <label className="schedule-label">Industry slots</label>
              <input
                className="schedule-slots-input"
                type="number"
                min={1}
                max={99}
                value={industrySlots}
                onChange={(e) => setIndustrySlots(Math.max(1, parseInt(e.target.value) || 1))}
              />
              <span className="schedule-arrow">→</span>
              <span className="schedule-result">{fmtDuration(mfgWallClock)}</span>
              {schedule.derivedIndustrySlots > 0 && industrySlots !== schedule.derivedIndustrySlots && (
                <button
                  className="schedule-reset-btn"
                  title={`Reset to skill-derived value (${schedule.derivedIndustrySlots})`}
                  onClick={() => setIndustrySlots(schedule.derivedIndustrySlots)}
                >
                  {schedule.derivedIndustrySlots} from skills
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
                value={targetMfgInput}
                onChange={(e) => setTargetMfgInput(e.target.value)}
              />
              <span className="schedule-label-unit">days</span>
              <span className="schedule-arrow">→</span>
              <span className="schedule-result">
                {reqIndustrySlots !== null
                  ? `${reqIndustrySlots} slot${reqIndustrySlots !== 1 ? "s" : ""}`
                  : "—"}
              </span>
              {reqIndustrySlots !== null && reqIndustrySlots !== industrySlots && (
                <button
                  className="schedule-apply-btn"
                  onClick={() => setIndustrySlots(reqIndustrySlots)}
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
            </colgroup>
            <thead>
              <tr>
                <th>Item</th>
                <th className="schedule-num">Runs</th>
                <th className="schedule-num">Time / run</th>
                <th className="schedule-num">Total work</th>
              </tr>
            </thead>
            <tbody>
              {schedule.manufacturing.map((j) => (
                <tr key={j.typeId}>
                  <td>{j.typeName}</td>
                  <td className="schedule-num">{j.runs.toLocaleString()}</td>
                  <td className="schedule-num">{fmtDuration(j.timePerRunSeconds)}</td>
                  <td className="schedule-num">{fmtDuration(j.runs * j.timePerRunSeconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
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
            </colgroup>
            <thead>
              <tr>
                <th>Item</th>
                <th className="schedule-num">Attempts</th>
                <th className="schedule-num">Probability</th>
                <th className="schedule-num">Exp. BPCs</th>
                <th className="schedule-num">Time / attempt</th>
                <th className="schedule-num">Total work</th>
              </tr>
            </thead>
            <tbody>
              {schedule.invention.map((j) => (
                <tr key={j.typeId}>
                  <td>{j.typeName.replace(" (Invention)", "")}</td>
                  <td className="schedule-num">{j.attempts.toLocaleString()}</td>
                  <td className="schedule-num">{(j.probability * 100).toFixed(1)}%</td>
                  <td className="schedule-num">{j.expectedBpcs.toFixed(1)}</td>
                  <td className="schedule-num">{fmtDuration(j.timePerAttemptSeconds)}</td>
                  <td className="schedule-num">{fmtDuration(j.attempts * j.timePerAttemptSeconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* ── Critical path ─────────────────────────────────────────────────── */}
      {(hasMfg || hasInv) && (
        <section className="schedule-critical">
          <span className="schedule-critical-label">Critical path</span>
          <span className="schedule-critical-time">{fmtDuration(criticalPath)}</span>
          {(hasMfg && hasInv) && (
            <span className="schedule-bottleneck">
              {balanced ? "balanced" : `${bottleneck} is the bottleneck`}
            </span>
          )}
          {hasMfg && hasInv && !balanced && (
            <span className="schedule-overlap-note">
              Invention and manufacturing run concurrently.
            </span>
          )}
        </section>
      )}

      {!hasMfg && !hasInv && (
        <div className="schedule-empty">
          No industry jobs in this plan. Solve the plan first, or all items are sourced by buying.
        </div>
      )}
    </div>
  );
}