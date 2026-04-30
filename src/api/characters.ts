import { invoke } from "@tauri-apps/api/core";
import type { CharacterId, CharacterInfo } from "./types";

/**
 * Start the OAuth2 PKCE flow.
 * Opens the browser, waits for the callback, stores tokens in the OS keychain,
 * and saves the character to the local DB.
 */
export async function addCharacter(): Promise<CharacterInfo> {
  return invoke<CharacterInfo>("add_character");
}

/**
 * Remove a character from the local DB and delete its stored tokens.
 * Does not affect ESI cached data already saved to the DB.
 */
export async function removeCharacter(
  characterId: CharacterId,
): Promise<void> {
  return invoke("remove_character", { characterId });
}

/** Return all authenticated characters stored in the local DB. */
export async function listCharacters(): Promise<CharacterInfo[]> {
  return invoke<CharacterInfo[]>("list_characters");
}

/**
 * Refresh ESI data for a single character (respects cache — only fetches
 * if the cached value has expired).
 */
export async function refreshEsiData(characterId: CharacterId): Promise<void> {
  return invoke("refresh_esi_data", { characterId });
}

/**
 * Refresh ESI data for all authenticated characters in parallel.
 * Market-wide data (prices, cost indices) is fetched once and shared.
 */
export async function refreshAllEsiData(): Promise<void> {
  return invoke("refresh_all_esi_data");
}

/** Set the corp assets mode for a character: "personal" | "corp" | "both". */
export async function setCorpAssetsMode(
  characterId: CharacterId,
  mode: "personal" | "corp" | "both",
): Promise<void> {
  return invoke("set_corp_assets_mode", { characterId, mode });
}
