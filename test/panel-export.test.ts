import { test } from "node:test";
import assert from "node:assert/strict";
import { VizType } from "@/lib/ir";
import {
  CSV_BOM,
  csvCell,
  type ExportableResult,
  exportFilename,
  slugify,
  supportsImageExport,
  toCsv,
} from "@/lib/panel-export";

const AT = new Date(2026, 8, 22, 14, 7); // 22 Sep 2026, 14:07 local

/* -------------------------------------------------------------------------- */
/* Filenames                                                                  */
/* -------------------------------------------------------------------------- */

test("a filename names the dashboard, the panel, and when it was taken", () => {
  assert.equal(
    exportFilename({
      dashboard: "Prod API",
      panel: "p95 Latency",
      extension: "csv",
      at: AT,
    }),
    "prod-api-p95-latency-20260922-1407.csv",
  );
});

test("a surface with no dashboard title exports by panel alone", () => {
  assert.equal(
    exportFilename({ panel: "Errors", extension: "png", at: AT }),
    "errors-20260922-1407.png",
  );
});

test("a title of pure punctuation still produces a usable filename", () => {
  assert.equal(
    exportFilename({ dashboard: "???", panel: "!!!", extension: "csv", at: AT }),
    "20260922-1407.csv",
  );
});

test("slugs are bounded and never end in a stray separator", () => {
  const slug = slugify(`${"a".repeat(60)} tail`);
  assert.ok(slug.length <= 48);
  assert.ok(!slug.endsWith("-"));
  assert.equal(slugify("p95 Latency (ms)"), "p95-latency-ms");
  assert.equal(slugify("  --Errors--  "), "errors");
});

/* -------------------------------------------------------------------------- */
/* Cells                                                                      */
/* -------------------------------------------------------------------------- */

test("a field is quoted exactly when RFC 4180 says it must be", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("line1\nline2"), '"line1\nline2"');
  assert.equal(csvCell("carriage\rreturn"), '"carriage\rreturn"');
});

test("numbers are written as numbers, not as quoted text", () => {
  assert.equal(csvCell(42), "42");
  assert.equal(csvCell(-1.5), "-1.5");
  assert.equal(csvCell(0), "0");
  assert.equal(csvCell(BigInt(10)), "10");
  assert.equal(csvCell(true), "true");
});

test("a negative number keeps its sign — the formula guard is for text only", () => {
  // The guard below must never touch this: an export whose numbers arrive as
  // text is not an export of metrics.
  assert.equal(csvCell(-5), "-5");
});

test("a text cell that a spreadsheet would run as a formula is neutralized", () => {
  // `=cmd|'…'!A1` in a cell is an attack on whoever opens the file, and these
  // values come from a database this app does not own.
  assert.equal(csvCell("=1+1"), "'=1+1");
  assert.equal(csvCell("+44 20"), "'+44 20");
  assert.equal(csvCell("-lead"), "'-lead");
  assert.equal(csvCell("@here"), "'@here");
  assert.equal(csvCell("\ttabbed"), "'\ttabbed");
  // Still quoted when it also needs quoting.
  assert.equal(csvCell("=a,b"), `"'=a,b"`);
});

test("null, undefined and things that cannot be written come out empty", () => {
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell(Symbol("x")), "");
  assert.equal(
    csvCell(() => 1),
    "",
  );
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(csvCell(circular), "");
});

test("dates and objects are written in a form that reads back", () => {
  assert.equal(csvCell(new Date("2026-09-22T14:07:00.000Z")), "2026-09-22T14:07:00.000Z");
  assert.equal(csvCell(new Date("nonsense")), "");
  assert.equal(csvCell({ a: 1 }), '"{""a"":1}"');
});

/* -------------------------------------------------------------------------- */
/* The file                                                                   */
/* -------------------------------------------------------------------------- */

const DATA: ExportableResult = {
  columns: ["ts", "value"],
  rows: [
    { ts: "2026-09-22T14:00:00Z", value: 1 },
    { ts: "2026-09-22T14:01:00Z", value: 2 },
  ],
};

test("the file is a header row and a row per row, CRLF terminated", () => {
  assert.equal(
    toCsv(DATA),
    "ts,value\r\n2026-09-22T14:00:00Z,1\r\n2026-09-22T14:01:00Z,2\r\n",
  );
});

test("columns decide the shape: extras are dropped and gaps are empty", () => {
  const csv = toCsv({
    columns: ["a", "b"],
    rows: [{ a: 1, extra: "ignored" }, { b: 2 }],
  });
  assert.equal(csv, "a,b\r\n1,\r\n,2\r\n");
});

test("rows are exported in the order the panel holds them", () => {
  const csv = toCsv({ columns: ["n"], rows: [{ n: 3 }, { n: 1 }, { n: 2 }] });
  assert.equal(csv, "n\r\n3\r\n1\r\n2\r\n");
});

test("a panel with no columns exports nothing, not a blank line", () => {
  assert.equal(toCsv({ columns: [], rows: [{ a: 1 }] }), "");
});

test("a panel with columns and no rows exports its header", () => {
  assert.equal(toCsv({ columns: ["a"], rows: [] }), "a\r\n");
});

test("a malformed frame degrades to an empty export rather than throwing", () => {
  // Rows reach the client through an SSE frame that is parsed and merged, not
  // re-validated, so this shape is reachable.
  const bad = { columns: null, rows: null } as unknown as ExportableResult;
  assert.doesNotThrow(() => toCsv(bad));
  assert.equal(toCsv(bad), "");
  const halfBad = { columns: ["a", 1], rows: [null] } as unknown as ExportableResult;
  assert.equal(toCsv(halfBad), "a\r\n\r\n");
});

test("the BOM is the download's job, not the text's", () => {
  // Excel needs it to read UTF-8; a test asserting the CSV text itself would
  // otherwise start with an invisible character.
  assert.ok(!toCsv(DATA).startsWith(CSV_BOM));
  assert.equal(CSV_BOM, "﻿");
});

/* -------------------------------------------------------------------------- */
/* Which panels can be a picture                                              */
/* -------------------------------------------------------------------------- */

test("a PNG is offered exactly where there is a chart to export", () => {
  // Exhaustive over the IR's own enum, so adding a viz forces a decision here
  // rather than silently inheriting one.
  const nonChart = new Set<VizType>(["stat", "table"]);
  for (const viz of VizType.options) {
    assert.equal(supportsImageExport(viz), !nonChart.has(viz), viz);
  }
});
