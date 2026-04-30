/**
 * Frontend analytics helper.
 * The actual ping fires from the Rust backend (analytics.rs) on launch —
 * this module is for any additional frontend-side event tracking.
 * Always check consent before calling.
 */
import { getAnalyticsConsent } from "../api/settings";

/** Returns true only if the user has explicitly opted in. */
export async function isAnalyticsGranted(): Promise<boolean> {
  const consent = await getAnalyticsConsent();
  return consent === "Granted";
}
