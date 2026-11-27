// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { JobType, SecurityClass, StructureHull, StructureProfile } from "../api";

export const SECURITY_OPTIONS: { value: SecurityClass; label: string }[] = [
  { value: "Highsec", label: "High-sec" },
  { value: "Lowsec",  label: "Low-sec" },
  { value: "Nullsec", label: "Null-sec / W-space" },
];

export const HULL_OPTIONS: { value: StructureHull; label: string }[] = [
  { value: "None",    label: "NPC station / other" },
  { value: "Raitaru", label: "Raitaru" },
  { value: "Azbel",   label: "Azbel" },
  { value: "Sotiyo",  label: "Sotiyo" },
  { value: "Athanor", label: "Athanor" },
  { value: "Tatara",  label: "Tatara" },
];

/** SCC surcharge on every industry job, as a fraction of EIV. Mirrors `cost::SCC_SURCHARGE`. */
export const SCC_SURCHARGE = 0.04;

/**
 * Rig ME/TE bonus multiplier for a structure's security band.
 * Mirrors `SecurityClass::rig_multiplier` in the backend (SDE dogma values):
 * engineering rigs 1.0 / 1.9 / 2.1, reactor rigs 1.0 / 1.1.
 */
export function rigMultiplier(security: SecurityClass, jobType: JobType): number {
  if (jobType === "Reaction") return security === "Nullsec" ? 1.1 : 1.0;
  if (security === "Lowsec") return 1.9;
  if (security === "Nullsec") return 2.1;
  return 1.0;
}

const isEngineeringComplex = (hull: StructureHull) =>
  hull === "Raitaru" || hull === "Azbel" || hull === "Sotiyo";

// Hull role bonuses below mirror `StructureHull` in the backend (SDE dogma).

/** Fractional reduction of the system cost index from the hull. */
export function hullJobCostBonus(hull: StructureHull, jobType: JobType): number {
  if (jobType === "Reaction") return 0;
  return hull === "Raitaru" ? 0.03 : hull === "Azbel" ? 0.04 : hull === "Sotiyo" ? 0.05 : 0;
}

/** Fractional material reduction from the hull. */
export function hullMeBonus(hull: StructureHull, jobType: JobType): number {
  return jobType === "Manufacturing" && isEngineeringComplex(hull) ? 0.01 : 0;
}

/** Fractional job time reduction from the hull. */
export function hullTeBonus(hull: StructureHull, jobType: JobType): number {
  if (jobType === "Reaction") return hull === "Tatara" ? 0.25 : 0;
  return hull === "Raitaru" ? 0.15 : hull === "Azbel" ? 0.20 : hull === "Sotiyo" ? 0.30 : 0;
}

/** Job cost bonus for a profile (0 when there is no profile). */
export function profileJobCostBonus(profile: StructureProfile | null | undefined): number {
  return profile ? hullJobCostBonus(profile.hull, profile.jobType) : 0;
}

/** System cost index after the structure's hull job cost bonus. */
export function effectiveCostIndex(idx: number, profile: StructureProfile | null | undefined): number {
  return idx * (1 - profileJobCostBonus(profile));
}

/** Percent string with up to two decimals and no trailing zeros, e.g. 0.05 → "5". */
export function pctLabel(fraction: number): string {
  return String(parseFloat((fraction * 100).toFixed(2)));
}
