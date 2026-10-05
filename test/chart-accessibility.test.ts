import assert from "node:assert/strict";
import { test } from "node:test";
import type { Panel } from "@/lib/ir";
import { CHART_TABLE_ROWS_MAX, chartDescription, chartTable } from "@/lib/panel-reading";

/*
 * What a screen reader gets in place of a canvas (#77): a name for the chart
 * and the rows it draws, as a table. Both are read from the same data the
 * chart is given, so they cannot say what the picture does not.
 */

const UTC = { timeZone: "UTC", clock: "24h" } as const;

const panel: Panel = {
  id: "rps",
  title: "Requests / min",
  viz: "line",
  format: "number",
  query: { sourceId: "s", sql: "SELECT 1", timeField: "minute" },
  layout: { x: 0, y: 0, w: 6, h: 4 },
};

test("the table carries every column and formats time and values", () => {
  const t = chartTable(
    panel,
    {
      columns: ["minute", "requests"],
      rows: [{ minute: "2026-10-05T12:00:00Z", requests: 12345 }],
    },
    UTC,
  );
  assert.deepEqual(t.columns, ["minute", "requests"]);
  assert.equal(t.rows.length, 1);
  assert.match(t.rows[0][0], /12:00:00/);
  assert.equal(t.rows[0][1], "12,345");
  assert.equal(t.caption, "Data for Requests / min: 1 row.");
});

test("a long series keeps the newest rows and says how many it left out", () => {
  const rows = Array.from({ length: CHART_TABLE_ROWS_MAX + 10 }, (_, i) => ({
    minute: new Date(Date.UTC(2026, 9, 5, 0, i)).toISOString(),
    requests: i,
  }));
  const t = chartTable(panel, { columns: ["minute", "requests"], rows }, UTC);
  assert.equal(t.rows.length, CHART_TABLE_ROWS_MAX);
  assert.equal(t.rows.at(-1)?.[1], String(CHART_TABLE_ROWS_MAX + 9));
  assert.match(t.caption, new RegExp(`newest ${CHART_TABLE_ROWS_MAX} of ${rows.length}`));
});

test("the description names the chart and never a value", () => {
  assert.equal(
    chartDescription(panel, 3),
    "Requests / min, line chart. The data is in the table that follows.",
  );
  assert.equal(chartDescription(panel, 0), "Requests / min, line chart, no data yet.");
  assert.match(
    chartDescription({ ...panel, viz: "state-timeline" }, 1),
    /state timeline/,
  );
});
