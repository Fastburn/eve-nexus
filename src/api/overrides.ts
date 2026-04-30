import { invoke } from "@tauri-apps/api/core";
import type {
  BlueprintOverrideEntry,
  Decision,
  ManualDecisionEntry,
  TypeId,
} from "./types";

// ── Blueprint ME/TE overrides ─────────────────────────────────────────────────

/** Return all blueprint ME/TE overrides currently saved. */
export async function getBlueprintOverrides(): Promise<
  BlueprintOverrideEntry[]
> {
  return invoke<BlueprintOverrideEntry[]>("get_blueprint_overrides");
}

/** Save a ME/TE override for a single blueprint type. */
export async function setBlueprintOverride(
  typeId: TypeId,
  meLevel: number,
  teLevel: number,
): Promise<void> {
  return invoke("set_blueprint_override", { typeId, meLevel, teLevel });
}

/** Remove the ME/TE override for a type (reverts to default ME10/TE20). */
export async function clearBlueprintOverride(typeId: TypeId): Promise<void> {
  return invoke("clear_blueprint_override", { typeId });
}

// ── Manual build/buy decisions ────────────────────────────────────────────────

/** Return all manual build/buy decision overrides. */
export async function getManualDecisions(): Promise<ManualDecisionEntry[]> {
  return invoke<ManualDecisionEntry[]>("get_manual_decisions");
}

/** Force the solver to use a specific decision for a type. */
export async function setManualDecision(
  typeId: TypeId,
  decision: Decision,
): Promise<void> {
  return invoke("set_manual_decision", { typeId, decision });
}

/** Remove the manual decision override for a type. */
export async function clearManualDecision(typeId: TypeId): Promise<void> {
  return invoke("clear_manual_decision", { typeId });
}

// ── Blacklist ─────────────────────────────────────────────────────────────────

/** Return all blacklisted type IDs. */
export async function getBlacklist(): Promise<TypeId[]> {
  return invoke<TypeId[]>("get_blacklist");
}

/** Add a type to the blacklist (solver will always buy it, never build). */
export async function addToBlacklist(typeId: TypeId): Promise<void> {
  return invoke("add_to_blacklist", { typeId });
}

/** Remove a type from the blacklist. */
export async function removeFromBlacklist(typeId: TypeId): Promise<void> {
  return invoke("remove_from_blacklist", { typeId });
}
