import type { TableSort } from "@/lib/chat/view";

/**
 * Filtering, sorting and exporting a result table (a Chat panel's, #416).
 *
 * Browser-safe and pure, over the rows the guarded query already returned:
 * nothing here reaches the database, so a filter narrows what is shown, never
 * what was read.
 */

export type Row = Record<string, unknown>;

/** Text to match: anywhere in a row, and per column. Blank matches everything. */
export interface RowFilters {
  text: string;
  columns: Record<string, string>;
}

export const EMPTY_FILTERS: RowFilters = { text: "", columns: {} };

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

/** Case-insensitive "contains", across the given columns and per column. */
export function filterRows(
  rows: readonly Row[],
  columns: readonly string[],
  filters: RowFilters,
): Row[] {
  const text = filters.text.trim().toLowerCase();
  const perColumn = Object.entries(filters.columns)
    .map(([column, value]) => [column, value.trim().toLowerCase()] as const)
    .filter(([column, value]) => value !== "" && columns.includes(column));
  if (!text && perColumn.length === 0) return [...rows];
  return rows.filter(
    (row) =>
      (!text || columns.some((c) => cellText(row[c]).toLowerCase().includes(text))) &&
      perColumn.every(([c, value]) => cellText(row[c]).toLowerCase().includes(value)),
  );
}

/** Whether any filter is narrowing the rows. */
export function isFiltering(filters: RowFilters): boolean {
  return (
    filters.text.trim() !== "" ||
    Object.values(filters.columns).some((v) => v.trim() !== "")
  );
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/** A stable sort; blanks go last in either direction. */
export function sortRows(rows: readonly Row[], sort: TableSort | null): Row[] {
  if (!sort) return [...rows];
  const sign = sort.order === "desc" ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((x, y) => {
      const a = x.row[sort.column];
      const b = y.row[sort.column];
      if (isBlank(a) || isBlank(b)) {
        return isBlank(a) === isBlank(b) ? x.index - y.index : isBlank(a) ? 1 : -1;
      }
      return sign * compare(a, b) || x.index - y.index;
    })
    .map(({ row }) => row);
}

/** Clicking a header: ascending, then descending, then the query's own order. */
export function nextSort(current: TableSort | null, column: string): TableSort | null {
  if (current?.column !== column) return { column, order: "asc" };
  return current.order === "asc" ? { column, order: "desc" } : null;
}

/**
 * One CSV field. Quoted when it must be (RFC 4180), and a value a spreadsheet
 * would run as a formula is prefixed with `'` so opening the file cannot
 * execute what the database held.
 */
function csvField(value: unknown): string {
  let text = cellText(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The rows as CSV, header first, in the given column order. */
export function toCsv(columns: readonly string[], rows: readonly Row[]): string {
  return [columns, ...rows.map((row) => columns.map((c) => row[c]))]
    .map((cells) => cells.map(csvField).join(","))
    .join("\r\n");
}

/** A filename from a title: lowercase words joined by dashes. */
export function csvFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "chat-result"}.csv`;
}
