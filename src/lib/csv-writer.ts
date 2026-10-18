/**
 * A small CSV writer (#597), for the sheets of an uploaded Excel workbook.
 *
 * It writes what DuckDB's CSV sniffer reads back as the type the cell had:
 * a number bare, a boolean as `true` or `false`, a date as ISO 8601, and
 * text always quoted, with an embedded quote doubled, so a comma, a quote or
 * a line break inside a cell stays inside it and a text cell that looks
 * numeric (`00123`) keeps its text. An empty cell is an empty field. Rows
 * end in `\n` and are padded to the sheet's width, so every row has as many
 * fields as the header.
 */

/** A date or time cell, as a UTC instant and how much of it the cell shows. */
export interface CsvDate {
  /** Milliseconds since the epoch, UTC; whole seconds. */
  ms: number;
  /** `date` is `YYYY-MM-DD`, `datetime` adds `THH:MM:SS`, `time` is `HH:MM:SS`. */
  show: "date" | "datetime" | "time";
}

/** One cell: text, a number, a boolean, a date, or empty. */
export type CsvCell = string | number | boolean | CsvDate | null;

const two = (n: number) => String(n).padStart(2, "0");

/**
 * A date as ISO 8601 in UTC: `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM:SS` or
 * `HH:MM:SS`. A `date` that carries a time of day is written with it.
 */
export function isoDate(date: CsvDate): string {
  const d = new Date(date.ms);
  const day = `${String(d.getUTCFullYear()).padStart(4, "0")}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
  const time = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
  if (date.show === "time") return time;
  if (date.show === "date" && time === "00:00:00") return day;
  return `${day}T${time}`;
}

/** Text, quoted, with every embedded quote doubled. */
export function quoteCsv(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

/** One field: a number bare, a boolean as `true`/`false`, a date as ISO 8601, text quoted. */
export function csvField(cell: CsvCell): string {
  if (cell === null) return "";
  if (typeof cell === "string") return quoteCsv(cell);
  if (typeof cell === "boolean") return cell ? "true" : "false";
  if (typeof cell === "number") return Number.isFinite(cell) ? String(cell) : "";
  return isoDate(cell);
}

/** One row of `width` fields, padded with empty ones, ending in `\n`. */
export function csvRow(cells: readonly (CsvCell | undefined)[], width: number): string {
  const fields: string[] = [];
  for (let i = 0; i < width; i++) fields.push(csvField(cells[i] ?? null));
  return `${fields.join(",")}\n`;
}

/**
 * The header row: each cell's text, quoted, and `column_<n>` (counting from
 * 1) for a cell that is empty or only whitespace, padded to `width`.
 */
export function csvHeader(
  cells: readonly (CsvCell | undefined)[],
  width: number,
): string {
  const names: string[] = [];
  for (let i = 0; i < width; i++) {
    const cell = cells[i] ?? null;
    const text =
      cell === null ? "" : typeof cell === "object" ? isoDate(cell) : String(cell);
    names.push(quoteCsv(text.trim() === "" ? `column_${i + 1}` : text));
  }
  return `${names.join(",")}\n`;
}
