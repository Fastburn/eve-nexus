// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BlueprintOverrideEntry,
  BuildTarget,
  Decision,
  ManualDecisionEntry,
  SolvePlanRequest,
  StructureProfile,
  TypeId,
} from "../api";

/** Build a SolvePlanRequest from the current in-memory plan/settings state. */
export function buildSolveRequest(
  targets: BuildTarget[],
  blueprintOverrides: BlueprintOverrideEntry[],
  structureProfiles: StructureProfile[],
  manualDecisions: ManualDecisionEntry[],
  blacklist: TypeId[],
  multiplier = 1,
): SolvePlanRequest {
  const meLevels: Record<number, number> = {};
  const teLevels: Record<number, number> = {};
  for (const o of blueprintOverrides) {
    meLevels[o.typeId] = o.meLevel;
    teLevels[o.typeId] = o.teLevel;
  }
  const profileMap: Record<string, StructureProfile> = {};
  for (const p of structureProfiles) profileMap[p.id] = p;
  const decisionMap: Record<number, Decision> = {};
  for (const d of manualDecisions) decisionMap[d.typeId] = d.decision;

  const scaledTargets = multiplier === 1
    ? targets
    : targets.map((t) => ({ ...t, quantity: Math.ceil(t.quantity * multiplier) }));

  return {
    targets: scaledTargets,
    meLevels,
    teLevels,
    structureProfiles: profileMap,
    manualDecisions: decisionMap,
    blacklist,
  };
}