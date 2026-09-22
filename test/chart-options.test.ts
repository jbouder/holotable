import { test } from "node:test";
import assert from "node:assert/strict";
import type { Panel } from "@/lib/ir";
import { buildChartOption, type PanelData } from "@/components/charts/options";

function panel(overrides: Partial<Panel> = {}): Panel {
  return {
    id: "p1",
    title: "Requests",
    viz: "line",
    query: { sourceId: "src-1", sql: "SELECT ts, v FROM m", timeField: "ts" },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    ...overrides,
  };
}

/**
 * `PanelErrorBoundary` is the backstop for a render throw, but a panel that
 * degrades to an empty chart beats one that degrades to an error card. Rows
 * reach the builder from a JSON-parsed SSE frame that is never re-validated,
 * so every shape below is reachable in principle.
 */

const VIZ: Panel["viz"][] = ["line", "area", "bar", "scatter", "pie", "donut", "heatmap"];

const JUNK: PanelData[] = [
  { columns: [], rows: [] },
  { columns: ["ts", "v"], rows: [] },
  // Row entries that are not objects.
  { columns: ["ts", "v"], rows: [null, 3, "x"] as unknown as PanelData["rows"] },
  // Columns that are not strings.
  { columns: [1, null, "v"] as unknown as string[], rows: [{ v: 1 }] },
  // Missing containers entirely.
  { columns: undefined, rows: undefined } as unknown as PanelData,
  // Cell values that resist String()/Number().
  {
    columns: ["ts", "v"],
    rows: [{ ts: Symbol("s"), v: Symbol("s") }] as unknown as PanelData["rows"],
  },
  { columns: ["ts", "v"], rows: [{ ts: { nested: true }, v: [1, 2] }] },
  { columns: ["ts", "v"], rows: [{ ts: BigInt(10), v: BigInt(5) }] },
];

for (const viz of VIZ) {
  test(`buildChartOption does not throw on unexpected row shapes (${viz})`, () => {
    for (const data of JUNK) {
      assert.doesNotThrow(
        () => buildChartOption(panel({ viz }), data),
        `viz=${viz} data=${JSON.stringify(data, (_k, v) => (typeof v === "bigint" || typeof v === "symbol" ? String(v) : v))}`,
      );
    }
  });
}

test("non-object rows are dropped rather than rendered", () => {
  const option = buildChartOption(panel(), {
    columns: ["ts", "v"],
    rows: [{ ts: "t0", v: 1 }, null, { ts: "t1", v: 2 }] as unknown as PanelData["rows"],
  });
  assert.deepEqual((option.xAxis as { data: string[] }).data, ["t0", "t1"]);
});

test("a well-formed line panel is unchanged by the normalization", () => {
  const option = buildChartOption(panel(), {
    columns: ["ts", "v"],
    rows: [
      { ts: "t0", v: 1 },
      { ts: "t1", v: 2 },
    ],
  });
  assert.deepEqual((option.xAxis as { data: string[] }).data, ["t0", "t1"]);
  const series = option.series as { name: string; data: number[] }[];
  assert.equal(series.length, 1);
  assert.equal(series[0].name, "v");
  assert.deepEqual(series[0].data, [1, 2]);
});
