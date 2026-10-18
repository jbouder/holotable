import { test } from "node:test";
import assert from "node:assert/strict";
import { csvField, csvHeader, csvRow, isoDate } from "@/lib/csv-writer";

/**
 * The CSV writer a workbook's sheets are converted through (#597): what it
 * writes is what DuckDB's sniffer types the column from, so text that looks
 * like a number must stay quoted text, and a comma, a quote or a line break
 * inside a cell must stay inside it.
 */

test("text is always quoted, with embedded quotes doubled, so its commas, quotes and line breaks stay in the cell", () => {
  assert.equal(csvField("plain"), '"plain"');
  assert.equal(csvField("a, b"), '"a, b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('"'), '""""');
  assert.equal(csvField("line one\nline two\r\n"), '"line one\nline two\r\n"');
  assert.equal(csvField(""), '""');
});

test("text that looks numeric keeps its text, leading zeros and all", () => {
  assert.equal(csvField("00123"), '"00123"');
  assert.equal(csvField("1e5"), '"1e5"');
  assert.equal(csvField("TRUE"), '"TRUE"');
  assert.equal(csvField("2026-04-01"), '"2026-04-01"');
});

test("numbers and booleans are bare, empty is empty, and a non-finite number is empty", () => {
  assert.equal(csvField(42), "42");
  assert.equal(csvField(-0.125), "-0.125");
  assert.equal(csvField(1e21), "1e+21");
  assert.equal(csvField(true), "true");
  assert.equal(csvField(false), "false");
  assert.equal(csvField(null), "");
  assert.equal(csvField(Number.NaN), "");
  assert.equal(csvField(Number.POSITIVE_INFINITY), "");
});

test("dates are ISO 8601 in UTC: a date, a date with its time, or a time", () => {
  const day = Date.UTC(2026, 3, 1);
  const at = Date.UTC(2026, 3, 1, 8, 5, 9);
  assert.equal(isoDate({ ms: day, show: "date" }), "2026-04-01");
  // A date-formatted cell that carries a time is written with it.
  assert.equal(isoDate({ ms: at, show: "date" }), "2026-04-01T08:05:09");
  assert.equal(isoDate({ ms: day, show: "datetime" }), "2026-04-01T00:00:00");
  assert.equal(
    isoDate({ ms: Date.UTC(1899, 11, 30, 23, 59, 59), show: "time" }),
    "23:59:59",
  );
  assert.equal(csvField({ ms: day, show: "date" }), "2026-04-01");
  assert.equal(isoDate({ ms: Date.UTC(999, 0, 2), show: "date" }), "0999-01-02");
});

test("a row is padded to the sheet's width, gaps included, and ends in a newline", () => {
  const cells: (string | number | null)[] = [];
  cells[0] = "a";
  cells[2] = 3;
  assert.equal(csvRow(cells, 4), '"a",,3,\n');
  assert.equal(csvRow([], 2), ",\n");
});

test("an empty header cell is column_<n>, counting from 1, and every name is quoted", () => {
  const cells: (string | number | null)[] = [];
  cells[0] = "date";
  cells[1] = "  ";
  cells[3] = 2026;
  assert.equal(csvHeader(cells, 5), '"date","column_2","column_3","2026","column_5"\n');
  assert.equal(csvHeader(['a "b", c'], 1), '"a ""b"", c"\n');
});
