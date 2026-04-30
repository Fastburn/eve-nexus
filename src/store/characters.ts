import { create } from "zustand";
import {
  listCharacters,
  addCharacter,
  removeCharacter,
  refreshAllEsiData,
  refreshEsiData,
} from "../api";
import type { CharacterId, CharacterInfo } from "../api";

interface CharactersState {
  // ── Data ──────────────────────────────────────────────────────────────────
  characters: CharacterInfo[];

  // ── Loading states ────────────────────────────────────────────────────────
  loading: boolean;
  refreshing: boolean;
  error: string | null;

  // ── Actions ───────────────────────────────────────────────────────────────
  fetch: () => Promise<void>;
  add: () => Promise<CharacterInfo>;
  remove: (characterId: CharacterId) => Promise<void>;
  refreshOne: (characterId: CharacterId) => Promise<void>;
  refreshAll: () => Promise<void>;
}

/** Extract a readable message from a Tauri command error (may be a plain string
 *  or a serialized CommandError object like { type: "invalidInput", message: "…" }). */
function esiErrorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const obj = e as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.type === "string") return obj.type;
    try { return JSON.stringify(e); } catch { /* fall through */ }
  }
  return String(e);
}

export const useCharactersStore = create<CharactersState>((set, get) => ({
  characters: [],
  loading: false,
  refreshing: false,
  error: null,

  fetch: async () => {
    set({ loading: true, error: null });
    try {
      const characters = await listCharacters();
      set({ characters, loading: false });
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },

  add: async () => {
    const info = await addCharacter();
    set((s) => ({ characters: [...s.characters, info] }));
    return info;
  },

  remove: async (characterId) => {
    await removeCharacter(characterId);
    set((s) => ({
      characters: s.characters.filter((c) => c.characterId !== characterId),
    }));
  },

  refreshOne: async (characterId) => {
    set({ refreshing: true, error: null });
    try {
      await refreshEsiData(characterId);
    } catch (e) {
      set({ error: esiErrorMessage(e) });
    } finally {
      set({ refreshing: false });
    }
  },

  refreshAll: async () => {
    if (get().characters.length === 0) return;
    set({ refreshing: true, error: null });
    try {
      await refreshAllEsiData();
    } catch (e) {
      set({ error: esiErrorMessage(e) });
    } finally {
      set({ refreshing: false });
    }
  },
}));
