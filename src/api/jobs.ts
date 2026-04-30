import { invoke } from "@tauri-apps/api/core";
import type { ActivityId, CharacterId, TypeId } from "./types";

export interface IndustryJobRow {
  characterId: CharacterId;
  characterName: string;
  jobId: number;
  blueprintTypeId: TypeId;
  outputTypeId: TypeId;
  activityId: ActivityId;
  runs: number;
  outputQuantity: number;
  /** RFC 3339 timestamp string. */
  endDate: string;
}

/** Return all active industry jobs for all authenticated characters, sorted by end date. */
export async function listIndustryJobs(): Promise<IndustryJobRow[]> {
  return invoke<IndustryJobRow[]>("list_industry_jobs");
}
