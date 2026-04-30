import { invoke } from "@tauri-apps/api/core";
import type { StructureProfile } from "./types";

/** Return all saved structure profiles. */
export async function getStructureProfiles(): Promise<StructureProfile[]> {
  return invoke<StructureProfile[]>("get_structure_profiles");
}

/** Create or update a structure profile (matched by profile.id). */
export async function saveStructureProfile(
  profile: StructureProfile,
): Promise<void> {
  return invoke("save_structure_profile", { profile });
}

/** Delete a structure profile by ID. */
export async function deleteStructureProfile(id: string): Promise<void> {
  return invoke("delete_structure_profile", { id });
}
