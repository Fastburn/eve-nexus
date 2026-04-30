import { invoke } from "@tauri-apps/api/core";
import type { BuildNode, SolvePlanRequest } from "./types";

/**
 * Solve a build plan from an ad-hoc target list.
 * Returns one BuildNode tree per target.
 */
export async function solveBuildPlan(
  request: SolvePlanRequest,
): Promise<BuildNode[]> {
  return invoke<BuildNode[]>("solve_build_plan", { request });
}

