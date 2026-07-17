// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BlueprintOverrideEntry,
  BuildTarget,
  Decision,
  DecrypterChoiceEntry,
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
  decrypterChoices: DecrypterChoiceEntry[] = [],
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
  const decrypterMap: Record<number, TypeId> = {};
  for (const d of decrypterChoices) decrypterMap[d.typeId] = d.decrypterTypeId;

  const scaledTargets = multiplier === 1
    ? targets
    : targets.map((t) => ({ ...t, quantity: Math.ceil(t.quantity * multiplier) }));

  return {
    targets: scaledTargets,
    meLevels,
    teLevels,
    structureProfiles: profileMap,
    manualDecisions: decisionMap,
    decrypterChoices: decrypterMap,
    blacklist,
  };
}