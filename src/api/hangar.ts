// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { invoke } from "@tauri-apps/api/core";
import type { BpcStockEntry, TypeId } from "./types";

/** Return the full virtual hangar as a map of typeId → quantity. */
export async function getVirtualHangar(): Promise<Record<TypeId, number>> {
  return invoke<Record<TypeId, number>>("get_virtual_hangar");
}

/**
 * Set the hangar quantity for a single type.
 * Passing quantity = 0 removes the entry entirely.
 */
export async function setHangarQuantity(
  typeId: TypeId,
  quantity: number,
): Promise<void> {
  return invoke("set_hangar_quantity", { typeId, quantity });
}

/** Return owned BPC stock as a map of typeId → { meLevel, teLevel, runsRemaining }. */
export async function getBpcInventory(): Promise<Record<TypeId, BpcStockEntry>> {
  return invoke<Record<TypeId, BpcStockEntry>>("get_bpc_inventory");
}

/**
 * Set the BPC stock for a single product type.
 * Passing runsRemaining = 0 removes the entry entirely.
 */
export async function setBpcStock(
  typeId: TypeId,
  meLevel: number,
  teLevel: number,
  runsRemaining: number,
): Promise<void> {
  return invoke("set_bpc_stock", { typeId, meLevel, teLevel, runsRemaining });
}