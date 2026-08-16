// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Extract a readable message from a Tauri command error (may be a plain string
 *  or a serialized CommandError object like { type: "invalidInput", message: "…" }). */
export function esiErrorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const obj = e as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.type === "string") return obj.type;
    try { return JSON.stringify(e); } catch { /* fall through */ }
  }
  return String(e);
}

/** Format a duration in seconds as a compact human-readable string (e.g. "3d 18h", "4h 32m"). */
export function fmtDuration(seconds: number): string {
  if (seconds <= 0) return "0s";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** Format an ISK value into a compact human-readable string (e.g. "1.23 B", "456.78 M"). */
export function fmtIsk(n: number | null | undefined): string {
  if (n == null || n === 0) return "—";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} B`;
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(2)} M`;
  if (n >= 1_000)         return `${(n / 1_000).toFixed(1)} K`;
  return n.toFixed(2);
}