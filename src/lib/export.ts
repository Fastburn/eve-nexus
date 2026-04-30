/**
 * Lightweight CSV / clipboard export helpers.
 * No dependencies beyond the browser Clipboard API and Blob/URL.
 */

/** Escape a single CSV field value. */
function csvField(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  // Wrap in quotes if it contains a comma, double-quote, or newline.
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Build a CSV string from a header row and data rows. */
export function buildCsv(
  headers: string[],
  rows: (string | number | null | undefined)[][],
): string {
  const lines: string[] = [headers.map(csvField).join(",")];
  for (const row of rows) {
    lines.push(row.map(csvField).join(","));
  }
  return lines.join("\r\n");
}

/** Build a TSV (tab-separated) string — ideal for clipboard paste into spreadsheets. */
export function buildTsv(
  headers: string[],
  rows: (string | number | null | undefined)[][],
): string {
  const escape = (v: string | number | null | undefined) =>
    v === null || v === undefined ? "" : String(v).replace(/\t/g, " ").replace(/\r?\n/g, " ");
  const lines: string[] = [headers.map(escape).join("\t")];
  for (const row of rows) {
    lines.push(row.map(escape).join("\t"));
  }
  return lines.join("\n");
}

/**
 * Trigger a CSV file download in the Tauri webview.
 * Adds a UTF-8 BOM so Excel opens it with correct encoding.
 */
export function downloadCsv(filename: string, content: string): void {
  const bom = "\uFEFF";
  const blob = new Blob([bom + content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Copy text to the system clipboard. */
export function copyText(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}
