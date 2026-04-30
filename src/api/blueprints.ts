import { invoke } from "@tauri-apps/api/core";
import type {
  BlueprintEntry,
  BlueprintOwnership,
  IndustryCategory,
  IndustryGroup,
} from "./types";

/** Return all product categories that have at least one blueprint. */
export function getIndustryCategories(): Promise<IndustryCategory[]> {
  return invoke("get_industry_categories");
}

/** Return all product groups within a category that have blueprints. */
export function getIndustryGroups(categoryId: number): Promise<IndustryGroup[]> {
  return invoke("get_industry_groups", { categoryId });
}

export interface BrowseBlueprintsParams {
  categoryId?: number | null;
  groupId?: number | null;
  query?: string | null;
  /** If true, only return blueprints owned by at least one character. */
  ownedOnly?: boolean;
}

/**
 * Browse blueprints with optional filters.
 *
 * Results are sorted so owned blueprints appear first, then alphabetically
 * by category → group → product name.
 */
export function browseBlueprints(
  params: BrowseBlueprintsParams = {},
): Promise<BlueprintEntry[]> {
  return invoke("browse_blueprints", {
    categoryId: params.categoryId ?? null,
    groupId: params.groupId ?? null,
    query: params.query ?? null,
    ownedOnly: params.ownedOnly ?? false,
  });
}

/**
 * Return all blueprints owned by any authenticated character,
 * each tagged with character identity and ME/TE stats.
 */
export function getCharacterBlueprints(): Promise<BlueprintOwnership[]> {
  return invoke("get_character_blueprints");
}
