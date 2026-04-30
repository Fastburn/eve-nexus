import { useEffect, useState, useCallback } from "react";
import { listIndustryJobs, getTypeNames, getSlotInfo } from "../../api";
import { TypeIcon } from "../common";
import type { IndustryJobRow, CharacterSlotInfo } from "../../api";
import "./MonitoringPanel.css";

// ── Countdown helpers ─────────────────────────────────────────────────────────

function msUntil(isoDate: string): number {
  return new Date(isoDate).getTime() - Date.now();
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "Done";
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

function urgencyClass(ms: number): string {
  if (ms <= 0)                  return "mp-done";
  if (ms < 60 * 60 * 1000)     return "mp-urgent";    // < 1 h
  if (ms < 4 * 60 * 60 * 1000) return "mp-soon";      // < 4 h
  return "";
}

// ── Activity label ────────────────────────────────────────────────────────────

const ACTIVITY_LABEL: Record<string, string> = {
  Manufacturing:    "Mfg",
  ResearchTime:     "TE Research",
  ResearchMaterial: "ME Research",
  Copying:          "Copy",
  Invention:        "Inv",
  Reaction:         "Reaction",
};

// ── Slot bar ──────────────────────────────────────────────────────────────────

interface SlotBarProps {
  label: string;
  active: number;
  max: number;
  tip: string;
}

function SlotBar({ label, active, max, tip }: SlotBarProps) {
  const idle    = max - active;
  const pct     = max > 0 ? (active / max) * 100 : 0;
  const isEmpty = active === 0;
  const isFull  = active >= max;

  return (
    <div className="mp-slot-row" title={tip}>
      <span className="mp-slot-label">{label}</span>
      <div className="mp-slot-track">
        <div
          className={`mp-slot-fill${isFull ? " full" : isEmpty ? " empty" : ""}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`mp-slot-count${isEmpty ? " mp-slot-idle" : isFull ? " mp-slot-full" : ""}`}>
        {active}/{max}
      </span>
      {idle > 0 && (
        <span className="mp-slot-idle-badge" title={`${idle} slot${idle !== 1 ? "s" : ""} idle — queue more jobs to maximise throughput`}>
          {idle} idle
        </span>
      )}
    </div>
  );
}

// ── Per-character slot section ────────────────────────────────────────────────

function CharSlots({ info }: { info: CharacterSlotInfo }) {
  const noSkills = info.maxManufacturing <= 1 && info.maxReaction <= 1 && info.maxResearch <= 1;

  return (
    <div className="mp-char-slots">
      <div className="mp-char-slots-name">
        {info.characterName}
        {noSkills && <span className="mp-char-no-skills" title="No slot skills trained — every idle slot is lost throughput">No slot skills</span>}
      </div>
      <SlotBar
        label="Manufacturing"
        active={info.activeManufacturing}
        max={info.maxManufacturing}
        tip={`Manufacturing slots: 1 base + Mass Production + Advanced Mass Production.\nActive: ${info.activeManufacturing}  Max: ${info.maxManufacturing}${info.maxManufacturing < 11 ? "\nTrain Mass Production / Advanced Mass Production to unlock more slots." : ""}`}
      />
      <SlotBar
        label="Reactions"
        active={info.activeReaction}
        max={info.maxReaction}
        tip={`Reaction slots: 1 base + Mass Reactions + Advanced Mass Reactions.\nActive: ${info.activeReaction}  Max: ${info.maxReaction}${info.maxReaction < 11 ? "\nTrain Mass Reactions / Advanced Mass Reactions to unlock more slots." : ""}`}
      />
      <SlotBar
        label="Research/Inv"
        active={info.activeResearch}
        max={info.maxResearch}
        tip={`Research/Copying/Invention slots: 1 base + Laboratory Operation + Advanced Laboratory Operation.\nActive: ${info.activeResearch}  Max: ${info.maxResearch}${info.maxResearch < 11 ? "\nTrain Laboratory Operation / Advanced Laboratory Operation to unlock more slots." : ""}`}
      />
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function MonitoringPanel() {
  const [jobs, setJobs]           = useState<IndustryJobRow[]>([]);
  const [slots, setSlots]         = useState<CharacterSlotInfo[]>([]);
  const [typeNames, setTypeNames] = useState<Record<number, string>>({});
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [tick, setTick]           = useState(0);

  const load = useCallback(async () => {
    try {
      const [data, slotData] = await Promise.all([listIndustryJobs(), getSlotInfo()]);
      setJobs(data);
      setSlots(slotData);
      setError(null);
      const ids = [...new Set(data.map((j) => j.outputTypeId))];
      if (ids.length > 0) {
        const names = await getTypeNames(ids);
        setTypeNames(names);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  void tick;

  if (loading) {
    return <div className="mp-state">Loading…</div>;
  }

  if (error) {
    return (
      <div className="mp-state mp-error">
        <span>Failed to load monitoring data</span>
        <span className="mp-error-detail">{error}</span>
        <button className="mp-retry" onClick={load}>Retry</button>
      </div>
    );
  }

  const active = jobs.filter((j) => msUntil(j.endDate) > 0);
  const done   = jobs.filter((j) => msUntil(j.endDate) <= 0);

  // Count total idle slots across all characters for the header callout.
  const totalIdle = slots.reduce((sum, c) => {
    const idleMfg   = Math.max(0, c.maxManufacturing - c.activeManufacturing);
    const idleReact = Math.max(0, c.maxReaction      - c.activeReaction);
    const idleRes   = Math.max(0, c.maxResearch       - c.activeResearch);
    return sum + idleMfg + idleReact + idleRes;
  }, 0);

  const noCharacters = slots.length === 0;

  return (
    <div className="mp">
      {/* ── Slot utilisation ── */}
      <div className="mp-slots-section">
        <div className="mp-slots-header">
          <span className="mp-slots-title">Job Slots</span>
          <span
            className={`mp-slots-idle-total${totalIdle > 0 ? " has-idle" : ""}`}
            title="Idle slots mean potential throughput going to waste. Queue more jobs or train slot skills to fill them."
          >
            {totalIdle > 0
              ? `${totalIdle} slot${totalIdle !== 1 ? "s" : ""} idle`
              : slots.length > 0 ? "All slots active" : ""}
          </span>
        </div>

        {noCharacters ? (
          <div className="mp-slot-tip">
            Add a character in the Characters tab to see slot utilisation.
          </div>
        ) : (
          <>
            {slots.map((info) => <CharSlots key={info.characterId} info={info} />)}
            {slots.length > 1 && (
              <div className="mp-char-slots mp-char-slots-total">
                <div className="mp-char-slots-name">All Characters</div>
                <SlotBar
                  label="Manufacturing"
                  active={slots.reduce((s, c) => s + c.activeManufacturing, 0)}
                  max={slots.reduce((s, c) => s + c.maxManufacturing, 0)}
                  tip="Combined manufacturing slots across all characters."
                />
                <SlotBar
                  label="Reactions"
                  active={slots.reduce((s, c) => s + c.activeReaction, 0)}
                  max={slots.reduce((s, c) => s + c.maxReaction, 0)}
                  tip="Combined reaction slots across all characters."
                />
                <SlotBar
                  label="Research/Inv"
                  active={slots.reduce((s, c) => s + c.activeResearch, 0)}
                  max={slots.reduce((s, c) => s + c.maxResearch, 0)}
                  tip="Combined research/invention slots across all characters."
                />
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Job counts ── */}
      {jobs.length > 0 && (
        <div className="mp-summary">
          <div className="mp-summary-cell">
            <span className="mp-summary-value">{active.length}</span>
            <span className="mp-summary-label">Active</span>
          </div>
          <div className="mp-summary-cell">
            <span className="mp-summary-value mp-done-val">{done.length}</span>
            <span className="mp-summary-label">Completed</span>
          </div>
        </div>
      )}

      {/* ── Active jobs ── */}
      {active.length > 0 && (
        <div className="mp-section">
          <div className="mp-section-title">Active Jobs</div>
          <div className="mp-job-list">
            {active.map((job) => {
              const ms = msUntil(job.endDate);
              return (
                <div key={job.jobId} className="mp-job-row">
                  <TypeIcon typeId={job.outputTypeId} variant="icon" size={32} displaySize={20} alt="" />
                  <div className="mp-job-info">
                    <span className="mp-job-type-id">{typeNames[job.outputTypeId] ?? `#${job.outputTypeId}`}</span>
                    <span className="mp-job-meta">
                      {ACTIVITY_LABEL[job.activityId] ?? job.activityId}
                      {" · "}{job.runs}× · {job.outputQuantity.toLocaleString()} units
                    </span>
                    <span className="mp-job-char">{job.characterName}</span>
                  </div>
                  <div className={`mp-countdown ${urgencyClass(ms)}`}>
                    {formatCountdown(ms)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Completed jobs ── */}
      {done.length > 0 && (
        <div className="mp-section">
          <div className="mp-section-title">Completed</div>
          <div className="mp-job-list">
            {done.map((job) => (
              <div key={job.jobId} className="mp-job-row mp-job-row-done">
                <TypeIcon typeId={job.outputTypeId} variant="icon" size={32} displaySize={20} alt="" />
                <div className="mp-job-info">
                  <span className="mp-job-type-id">{typeNames[job.outputTypeId] ?? `#${job.outputTypeId}`}</span>
                  <span className="mp-job-meta">
                    {ACTIVITY_LABEL[job.activityId] ?? job.activityId}
                    {" · "}{job.runs}× · {job.outputQuantity.toLocaleString()} units
                  </span>
                  <span className="mp-job-char">{job.characterName}</span>
                </div>
                <div className="mp-countdown mp-done">Done</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {jobs.length === 0 && !noCharacters && (
        <div className="mp-section">
          <div className="mp-state">
            <span>No industry jobs found.</span>
            <span>Refresh ESI data in the Characters tab.</span>
          </div>
        </div>
      )}

      <div className="mp-footer">
        Auto-refreshes every 5 min · Refresh ESI in Characters to pull from server
      </div>
    </div>
  );
}
