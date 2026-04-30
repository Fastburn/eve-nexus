import { invoke } from "@tauri-apps/api/core";
import type { TypeId } from "./types";

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
