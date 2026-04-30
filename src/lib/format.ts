/** Format an ISK value into a compact human-readable string (e.g. "1.23 B", "456.78 M"). */
export function fmtIsk(n: number | null | undefined): string {
  if (n == null || n === 0) return "—";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} B`;
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(2)} M`;
  if (n >= 1_000)         return `${(n / 1_000).toFixed(1)} K`;
  return n.toFixed(2);
}
