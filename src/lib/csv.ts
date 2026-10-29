/** Minimal RFC 4180 CSV parsing/serialization (quoted fields, embedded commas/quotes/newlines, BOM). */

export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (quoted) throw new Error("Unterminated quoted field");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

/** Parse with a header row into records keyed by lower-cased, trimmed header names. */
export function parseCsvRecords(text: string): {
  headers: string[];
  records: Array<Record<string, string>>;
} {
  const [header, ...rows] = parseCsv(text);
  if (!header) return { headers: [], records: [] };
  const headers = header.map((h) => h.trim().toLowerCase());
  const records = rows.map((cells) =>
    Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? "").trim()])),
  );
  return { headers, records };
}

function escapeField(value: string): string {
  // Neutralize spreadsheet formula injection (=, +, -, @ at the start of a text cell).
  const safe = /^[=+\-@\t\r]/.test(value) && !/^-?\d+(\.\d+)?$/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function toCsv(
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>,
): string {
  const lines = [headers, ...rows].map((r) =>
    r.map((v) => escapeField(v === null || v === undefined ? "" : String(v))).join(","),
  );
  // BOM so spreadsheet apps read UTF-8 (Arabic names) correctly.
  return "﻿" + lines.join("\r\n") + "\r\n";
}
