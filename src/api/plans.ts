import { invoke } from "@tauri-apps/api/core";
import type { PlanSummary, ProductionPlan } from "./types";

/** List all saved plans (lightweight — no target details). */
export async function listPlans(): Promise<PlanSummary[]> {
  return invoke<PlanSummary[]>("list_plans");
}

/** Load a full plan by ID. Returns null if not found. */
export async function getPlan(id: string): Promise<ProductionPlan | null> {
  return invoke<ProductionPlan | null>("get_plan", { id });
}

/** Create or update a plan (matched by plan.id). */
export async function savePlan(plan: ProductionPlan): Promise<void> {
  return invoke("save_plan", { plan });
}

/** Delete a plan by ID. */
export async function deletePlan(id: string): Promise<void> {
  return invoke("delete_plan", { id });
}
