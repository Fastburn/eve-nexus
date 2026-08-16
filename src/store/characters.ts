// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { create } from "zustand";
import {
  listCharacters,
  addCharacter,
  removeCharacter,
  refreshAllEsiData,
  refreshEsiData,
} from "../api";
import type { CharacterId, CharacterInfo } from "../api";
import { esiErrorMessage } from "../lib/format";

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
      set({ loading: false, error: esiErrorMessage(e) });
    }
  },

  add: async () => {
    const info = await addCharacter();
    set((s) => {
      const rest = s.characters.filter((c) => c.characterId !== info.characterId);
      return { characters: [...rest, info] };
    });
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
      // Pick up any flags (e.g. hasWalletScope) that changed as a result of the refresh.
      await get().fetch();
    } catch (e) {
      set({ error: esiErrorMessage(e) });
    } finally {
      set({ refreshing: false });
    }
  },

  refreshAll: async () => {
    set({ refreshing: true, error: null });
    try {
      await refreshAllEsiData();
      await get().fetch();
    } catch (e) {
      set({ error: esiErrorMessage(e) });
    } finally {
      set({ refreshing: false });
    }
  },
}));