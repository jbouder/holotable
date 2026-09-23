import type { VizType } from "@/lib/ir";

/**
 * Taking a panel's contents out of the browser (#76).
 *
 * The one rule that shapes everything here: an export is exactly what the
 * panel already holds — the bounded rolling window the client has been handed
 * frame by frame — and never a new question put to the database. So nothing in
 * this module fetches, and nothing it produces can contain a row the panel was
 * not already showing. "The full result set" is a server-side feature and a
 * different issue.
 */

/**
 * Which vizzes can be exported as a picture.
 *
 * A PNG comes out of the ECharts instance, so it exists exactly when there is
 * one. A stat is a number and a table is a table: neither renders on a canvas,
 * and a screenshot of one is a worse version of its CSV — so those panels are
 * offered the CSV alone rather than a PNG that would have to be faked.
 */
export function supportsImageExport(viz: VizType): boolean {
  return viz !== "stat" && viz !== "table";
}

/**
 * A result window as this module needs to see it.
 *
 * Structurally what `PanelData` is, declared here rather than imported so a
 * module in `src/lib` does not depend on one in `src/components`. It is not a
 * second opinion about the shape: a `PanelData` satisfies it, and nothing here
 * reads a field that is not on both.
 */
export interface ExportableResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

/** What the download is named after, and what it is. */
export interface ExportName {
  /** The dashboard's title, when the surface knows it. */
  dashboard?: string;
  panel: string;
  extension: "csv" | "png";
  /** Defaults to now; injectable so the name is testable. */
  at?: Date;
}

/** Windows forbids most of these outright; the rest just make bad filenames. */
const UNSAFE = /[^a-z0-9]+/g;

/** Long enough to stay recognisable, short enough to stay a filename. */
const SLUG_MAX = 48;

/** `"p95 Latency (ms)"` → `"p95-latency-ms"`, and `""` for a title of symbols. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(UNSAFE, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
}

/** `2026-09-22T14:07` as `20260922-1407`, in the reader's own timezone. */
function stamp(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}`
  );
}

/**
 * The name the file is saved under.
 *
 * Timestamped because exporting the same panel twice is the normal case —
 * before and after a deploy — and two files called `errors.csv` in a downloads
 * folder is how the comparison gets lost. Local time rather than UTC: the
 * reader is comparing it against a clock on a wall.
 */
export function exportFilename({ dashboard, panel, extension, at }: ExportName): string {
  const parts = [slugify(dashboard ?? ""), slugify(panel), stamp(at ?? new Date())];
  const name = parts.filter(Boolean).join("-");
  return `${name || "panel"}.${extension}`;
}

/* -------------------------------------------------------------------------- */
/* CSV                                                                        */
/* -------------------------------------------------------------------------- */

/** RFC 4180 says CRLF, and it is what a spreadsheet on Windows expects. */
const CRLF = "\r\n";

/**
 * A leading one of these makes a spreadsheet treat the cell as a formula.
 *
 * `=cmd|'…'!A1` in a cell is a real attack on whoever opens the file, and the
 * values in a panel come from a database this app does not own. Only *text*
 * cells are guarded: a negative number must stay a number, so the check is on
 * the string branch below rather than on the rendered text.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** RFC 4180: quote when the field holds a comma, a quote, or a line break. */
const NEEDS_QUOTING = /[",\r\n]/;

/**
 * One value as a CSV field.
 *
 * Every branch is reachable: rows arrive from an SSE frame that is parsed and
 * merged without being re-validated, so a column can hold anything JSON can.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";

  let text: string;
  switch (typeof value) {
    case "number":
    case "bigint":
    case "boolean":
      // Not quoted and not guarded: these are the numbers the export exists
      // for, and a spreadsheet should read them as numbers.
      return String(value);
    case "string":
      text = FORMULA_LEAD.test(value) ? `'${value}` : value;
      break;
    case "symbol":
    case "function":
      return "";
    default:
      if (value instanceof Date) {
        text = Number.isNaN(value.getTime()) ? "" : value.toISOString();
        break;
      }
      try {
        text = JSON.stringify(value) ?? "";
      } catch {
        // A circular object is not worth failing an export over.
        text = "";
      }
  }

  return NEEDS_QUOTING.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The panel's current window as CSV: a header row of its columns, then a row
 * per row, in the order the panel holds them.
 *
 * A panel with no columns produces an empty string rather than a file
 * containing one blank line — nothing useful can be written about it, and an
 * empty string is what the caller checks before offering the download.
 */
export function toCsv(data: ExportableResult): string {
  const columns = Array.isArray(data?.columns)
    ? data.columns.filter((c): c is string => typeof c === "string")
    : [];
  if (columns.length === 0) return "";

  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row?.[column])).join(","));
  }
  return lines.join(CRLF) + CRLF;
}

/**
 * Excel reads a UTF-8 file without this as the platform's legacy codepage, so
 * a `µ` or a `°` in a column name arrives as mojibake. It is prepended to the
 * downloaded blob rather than to {@link toCsv}, which stays plain text.
 */
export const CSV_BOM = "﻿";

/** Told to the reader before they open it: this is the window, not the query. */
export const CSV_SCOPE_NOTE =
  "Exports the window this panel is currently holding, not the full query result.";
