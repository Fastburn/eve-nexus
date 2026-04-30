import { invoke } from "@tauri-apps/api/core";

export interface RestockRow {
  typeId: number;
  typeName: string;
  targetQty: number;
  currentSellQty: number;
  deficit: number;
}

export async function getRestockRows(): Promise<RestockRow[]> {
  return invoke("get_restock_rows");
}

export async function saveRestockTarget(typeId: number, targetQty: number): Promise<void> {
  return invoke("save_restock_target", { typeId, targetQty });
}

export async function deleteRestockTarget(typeId: number): Promise<void> {
  return invoke("delete_restock_target", { typeId });
}

export async function getRestockMargin(): Promise<number> {
  return invoke("get_restock_margin");
}

export async function setRestockMargin(threshold: number): Promise<void> {
  return invoke("set_restock_margin", { threshold });
}
