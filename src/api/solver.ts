// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { invoke } from "@tauri-apps/api/core";
import type { BuildNode, PlanSchedule, SolvePlanRequest } from "./types";

/**
 * Solve a build plan from an ad-hoc target list.
 * Returns one BuildNode tree per target.
 */
export async function solveBuildPlan(
  request: SolvePlanRequest,
): Promise<BuildNode[]> {
  return invoke<BuildNode[]>("solve_build_plan", { request });
}

export async function computeSchedule(
  request: SolvePlanRequest,
  industrySlots: number,
  scienceSlots: number,
): Promise<PlanSchedule> {
  return invoke<PlanSchedule>("compute_schedule", { request, industrySlots, scienceSlots });
}