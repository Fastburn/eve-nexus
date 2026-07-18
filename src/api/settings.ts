// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { invoke } from "@tauri-apps/api/core";
import type { AnalyticsConsent } from "./types";

/** Whether the first-run wizard has been completed. */
export async function getWizardCompleted(): Promise<boolean> {
  return invoke<boolean>("get_wizard_completed");
}

/** Mark the first-run wizard as completed. */
export async function setWizardCompleted(): Promise<void> {
  return invoke("set_wizard_completed");
}

/** Return the current analytics opt-in state. */
export async function getAnalyticsConsent(): Promise<AnalyticsConsent> {
  return invoke<AnalyticsConsent>("get_analytics_consent");
}

/**
 * Set the analytics consent state.
 * "Granted" → pings fire on launch.
 * "Denied"  → no pings, ever.
 * "Pending" → first-run dialog not yet answered.
 */
export async function setAnalyticsConsent(
  consent: AnalyticsConsent,
): Promise<void> {
  return invoke("set_analytics_consent", { consent });
}

/** Global default overproduction multiplier (1.0 = no extra stock). */
export async function getDefaultOverproductionMultiplier(): Promise<number> {
  return invoke<number>("get_default_overproduction_multiplier");
}
export async function setDefaultOverproductionMultiplier(multiplier: number): Promise<void> {
  return invoke("set_default_overproduction_multiplier", { multiplier });
}

/** Global default freight cost in ISK/m³ (0.0 = no freight cost). */
export async function getDefaultFreightIskPerM3(): Promise<number> {
  return invoke<number>("get_default_freight_isk_per_m3");
}
export async function setDefaultFreightIskPerM3(iskPerM3: number): Promise<void> {
  return invoke("set_default_freight_isk_per_m3", { iskPerM3 });
}

/**
 * Whether the decrypter auto-pick optimizes for job time instead of ISK cost.
 * `false` (default) = minimize total ISK cost (invention spend + downstream
 * material cost from ME). `true` = minimize total job time instead.
 * Has no effect on an explicit per-item decrypter override.
 */
export async function getOptimizeDecryptersForTime(): Promise<boolean> {
  return invoke<boolean>("get_optimize_decrypters_for_time");
}
export async function setOptimizeDecryptersForTime(enabled: boolean): Promise<void> {
  return invoke("set_optimize_decrypters_for_time", { enabled });
}