// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { invoke } from "@tauri-apps/api/core";

export interface RestockRow {
  typeId: number;
  typeName: string;
  targetQty: number;
  /** null means this row uses the global default overbuild buffer. */
  overbuildPct: number | null;
  onMarketQty: number;
  /** ESI assets + virtual hangar, summed across all characters. */
  realStockQty: number;
  /** Units sold in the last 30 days; null if no character has wallet scope confirmed. */
  sellVelocity: number | null;
  /** Display-only hint derived from velocity; never stored. */
  suggestedTarget: number | null;
  deficit: number;
}

export async function getRestockRows(): Promise<RestockRow[]> {
  return invoke<RestockRow[]>("get_restock_rows");
}

export async function saveRestockTarget(
  typeId: number,
  targetQty: number,
  overbuildPct: number | null,
): Promise<void> {
  return invoke<void>("save_restock_target", { typeId, targetQty, overbuildPct });
}

export async function deleteRestockTarget(typeId: number): Promise<void> {
  return invoke<void>("delete_restock_target", { typeId });
}

export async function getRestockMargin(): Promise<number> {
  return invoke<number>("get_restock_margin");
}

export async function setRestockMargin(threshold: number): Promise<void> {
  return invoke<void>("set_restock_margin", { threshold });
}

export async function getDefaultOverbuildPct(): Promise<number> {
  return invoke<number>("get_default_overbuild_pct");
}

export async function setDefaultOverbuildPct(pct: number): Promise<void> {
  return invoke<void>("set_default_overbuild_pct", { pct });
}