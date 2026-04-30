import { invoke } from "@tauri-apps/api/core";

export interface EftItem {
  typeId: number;
  typeName: string;
  quantity: number;
}

export interface EftImportResult {
  items: EftItem[];
  unresolved: string[];
}

export async function importEftFit(eftText: string): Promise<EftImportResult> {
  return invoke<EftImportResult>("import_eft_fit", { eftText });
}
