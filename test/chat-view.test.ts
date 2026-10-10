import { test } from "node:test";
import assert from "node:assert/strict";
import type { QueryPanel } from "@/lib/ir";
import {
  EMPTY_TABLE_VIEW,
  initialTableView,
  initialView,
  viewChoices,
  viewPanel,
} from "@/lib/chat/view";
import {
  csvFilename,
  EMPTY_FILTERS,
  filterRows,
  isFiltering,
  nextSort,
  sortRows,
  toCsv,
} from "@/lib/result-table";

const timed: QueryPanel = {
  id: "explore",
  title: "Requests",
  viz: "line",
  query: { sourceId: "s", sql: "SELECT ts, v FROM m", timeField: "ts" },
  options: { legend: "right", yAxis: { label: "req/s" } },
  layout: { x: 0, y: 0, w: 6, h: 4 },
};

const untimed: QueryPanel = {
  id: "explore",
  title: "By route",
  viz: "pie",
  query: { sourceId: "s", sql: "SELECT route, n FROM m" },
  layout: { x: 0, y: 0, w: 6, h: 4 },
};

// --- Views -------------------------------------------------------------------

test("views: line and area only with a time field, and the model's kind first", () => {
  assert.deepEqual(viewChoices(timed), ["line", "area", "bar", "table", "stat"]);
  assert.deepEqual(viewChoices(untimed), ["pie", "bar", "table", "stat"]);
});

test("views: the series toggles start as the model drew it and round-trip", () => {
  const view = initialView(timed);
  assert.deepEqual(view, { viz: "line", legend: true, stacked: false, log: false });
  // Untouched, the panel is the one the model made.
  assert.deepEqual(viewPanel(timed, view, EMPTY_TABLE_VIEW), timed);

  const toggled = viewPanel(
    timed,
    { viz: "bar", legend: false, stacked: true, log: true },
    EMPTY_TABLE_VIEW,
  );
  assert.equal(toggled?.viz, "bar");
  assert.deepEqual(toggled?.options, {
    legend: "none",
    stacked: true,
    yAxis: { label: "req/s", log: true },
  });
});

test("views: a switch the IR would refuse is refused", () => {
  const fixedMin = { ...timed, options: { yAxis: { min: 0 } } };
  const log = { ...initialView(fixedMin), log: true };
  assert.equal(viewPanel(fixedMin, log, EMPTY_TABLE_VIEW), null);
});

test("views: a switch drops options the new kind does not take", () => {
  const stat = viewPanel(timed, { ...initialView(timed), viz: "stat" }, EMPTY_TABLE_VIEW);
  assert.equal(stat?.viz, "stat");
  assert.equal(stat?.options, undefined);
});

test("views: the table's hidden columns and sort become table options", () => {
  const table = viewPanel(
    untimed,
    { ...initialView(untimed), viz: "table" },
    { hidden: ["n"], sort: { column: "route", order: "desc" } },
  );
  assert.deepEqual(table?.options, {
    columns: [{ name: "n", hidden: true }],
    sort: { column: "route", order: "desc" },
  });
  assert.deepEqual(initialTableView(table as QueryPanel), {
    hidden: ["n"],
    sort: { column: "route", order: "desc" },
  });
});

// --- Table tools -------------------------------------------------------------

const rows = [
  { route: "/api/orders", status: 200, ms: 182 },
  { route: "/api/login", status: 500, ms: 940 },
  { route: "/health", status: 200, ms: null },
  { route: "/api/items", status: 200, ms: 31 },
];
const columns = ["route", "status", "ms"];

test("table: filters by text anywhere and per column", () => {
  assert.equal(filterRows(rows, columns, EMPTY_FILTERS).length, 4);
  assert.equal(isFiltering(EMPTY_FILTERS), false);
  const api = { text: "API", columns: {} };
  assert.deepEqual(
    filterRows(rows, columns, api).map((r) => r.route),
    ["/api/orders", "/api/login", "/api/items"],
  );
  const ok = { text: "api", columns: { status: "200" } };
  assert.equal(isFiltering(ok), true);
  assert.deepEqual(
    filterRows(rows, columns, ok).map((r) => r.route),
    ["/api/orders", "/api/items"],
  );
  // A column filter only matches its own column; an unknown column is ignored.
  assert.equal(
    filterRows(rows, columns, { text: "", columns: { route: "500" } }).length,
    0,
  );
  assert.equal(filterRows(rows, columns, { text: "", columns: { nope: "x" } }).length, 4);
});

test("table: sorts numbers as numbers, blanks last, and cycles on a header", () => {
  const up = sortRows(rows, { column: "ms", order: "asc" }).map((r) => r.ms);
  assert.deepEqual(up, [31, 182, 940, null]);
  const down = sortRows(rows, { column: "ms", order: "desc" }).map((r) => r.ms);
  assert.deepEqual(down, [940, 182, 31, null]);
  assert.deepEqual(sortRows(rows, null), rows);

  let sort = nextSort(null, "ms");
  assert.deepEqual(sort, { column: "ms", order: "asc" });
  sort = nextSort(sort, "ms");
  assert.deepEqual(sort, { column: "ms", order: "desc" });
  assert.equal(nextSort(sort, "ms"), null);
  assert.deepEqual(nextSort(sort, "route"), { column: "route", order: "asc" });
});

test("table: CSV quotes what it must and defuses spreadsheet formulas", () => {
  const csv = toCsv(
    ["a", "b"],
    [
      { a: 'say "hi", twice', b: 1 },
      { a: "=HYPERLINK(1)", b: null },
      { a: "-2", b: "line\nbreak" },
    ],
  );
  assert.equal(
    csv,
    ["a,b", '"say ""hi"", twice",1', "'=HYPERLINK(1),", `'-2,"line\nbreak"`].join("\r\n"),
  );
  assert.equal(csvFilename("p95 latency, by route!"), "p95-latency-by-route.csv");
  assert.equal(csvFilename("!!!"), "chat-result.csv");
});
