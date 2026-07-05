// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

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