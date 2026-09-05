// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

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
  return invoke<void>("save_structure_profile", { profile });
}

/** Delete a structure profile by ID. */
export async function deleteStructureProfile(id: string): Promise<void> {
  return invoke<void>("delete_structure_profile", { id });
}