import { invoke } from "@tauri-apps/api/core";
import type { TypeId, CharacterId } from "./types";

/**
 * Returns the maximum skill level across all authenticated characters for each
 * key industry skill.  Skills not yet trained are absent from the map.
 */
export async function getIndustrySkills(): Promise<Record<TypeId, number>> {
  return invoke<Record<TypeId, number>>("get_industry_skills");
}

export interface CharacterSlotInfo {
  characterId: CharacterId;
  characterName: string;
  /** Maximum concurrent manufacturing jobs (1 + Mass Production level). */
  maxManufacturing: number;
  /** Maximum concurrent reaction jobs (1 + Mass Reactions level). */
  maxReaction: number;
  /** Maximum concurrent research/copy/invention jobs (1 + Lab Op + Adv Lab Op). */
  maxResearch: number;
  activeManufacturing: number;
  activeReaction: number;
  /** Active research + copying + invention jobs (all share the research pool). */
  activeResearch: number;
}

/** Returns slot capacity and active job counts for every authenticated character. */
export async function getSlotInfo(): Promise<CharacterSlotInfo[]> {
  return invoke<CharacterSlotInfo[]>("get_slot_info");
}
