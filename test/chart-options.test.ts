import { test } from "node:test";
import assert from "node:assert/strict";
import type { Panel } from "@/lib/ir";
import {
  areaChart,
  barChart,
  LARGE_SERIES_POINTS,
  lineChart,
  type PanelData,
  scatterChart,
} from "@/components/charts/options";
import { PANEL_RENDERERS } from "@/components/panels/registry";
import { DEFAULT_CHART_THEME } from "@/lib/color/chart-theme";
import { LOCAL_TIME_DISPLAY } from "@/lib/time-display";

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

/** Every chart kind in the registry, so a new one is covered by being registered. */
const CHARTS = Object.entries(PANEL_RENDERERS).flatMap(([viz, renderer]) =>
  renderer.type === "chart"
    ? [{ viz: viz as Panel["viz"], option: renderer.option }]
    : [],
);

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

test("every chart kind is covered", () => {
  assert.deepEqual(
    CHARTS.map((c) => c.viz),
    [
      "line",
      "area",
      "bar",
      "scatter",
      "heatmap",
      "pie",
      "donut",
      "gauge",
      "state-timeline",
      "histogram",
      "treemap",
      "graph",
    ],
  );
});

for (const { viz, option } of CHARTS) {
  test(`a chart's option builder does not throw on unexpected row shapes (${viz})`, () => {
    for (const data of JUNK) {
      assert.doesNotThrow(
        () =>
          option(panel({ viz }), data, {
            display: LOCAL_TIME_DISPLAY,
            theme: DEFAULT_CHART_THEME,
          }),
        `viz=${viz} data=${JSON.stringify(data, (_k, v) => (typeof v === "bigint" || typeof v === "symbol" ? String(v) : v))}`,
      );
    }
  });
}

test("non-object rows are dropped rather than rendered", () => {
  const option = lineChart(
    panel(),
    {
      columns: ["ts", "v"],
      rows: [
        { ts: "t0", v: 1 },
        null,
        { ts: "t1", v: 2 },
      ] as unknown as PanelData["rows"],
    },
    { display: LOCAL_TIME_DISPLAY, theme: DEFAULT_CHART_THEME },
  );
  assert.deepEqual((option.xAxis as { data: string[] }).data, ["t0", "t1"]);
});

test("a well-formed line panel is unchanged by the normalization", () => {
  const option = lineChart(
    panel(),
    {
      columns: ["ts", "v"],
      rows: [
        { ts: "t0", v: 1 },
        { ts: "t1", v: 2 },
      ],
    },
    { display: LOCAL_TIME_DISPLAY, theme: DEFAULT_CHART_THEME },
  );
  assert.deepEqual((option.xAxis as { data: string[] }).data, ["t0", "t1"]);
  const series = option.series as { name: string; data: number[] }[];
  assert.equal(series.length, 1);
  assert.equal(series[0].name, "v");
  assert.deepEqual(series[0].data, [1, 2]);
});

/**
 * Large series (#491): past the threshold a line is sampled and straight,
 * bars and scatter use large mode, and the chart stops animating; at or under
 * it the option is what it always was.
 */
test("a series past the large threshold is sampled or drawn in large mode, and not before", () => {
  const ctx = { display: LOCAL_TIME_DISPLAY, theme: DEFAULT_CHART_THEME };
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      ts: new Date(Date.UTC(2026, 9, 11, 0, 0, i)).toISOString(),
      v: i % 17,
      w: i % 5,
    }));
  const data = (n: number): PanelData => ({ columns: ["ts", "v", "w"], rows: rows(n) });
  type Series = Record<string, unknown>;
  const seriesOf = (option: { series?: unknown }) => option.series as Series[];
  for (const n of [200, LARGE_SERIES_POINTS]) {
    for (const s of seriesOf(lineChart(panel(), data(n), ctx))) {
      assert.equal(s.sampling, undefined, `line at ${n}`);
      assert.equal(s.smooth, true, `line at ${n}`);
    }
    for (const s of seriesOf(barChart(panel({ viz: "bar" }), data(n), ctx))) {
      assert.equal(s.large, undefined, `bar at ${n}`);
    }
    for (const s of seriesOf(scatterChart(panel({ viz: "scatter" }), data(n), ctx))) {
      assert.equal(s.large, undefined, `scatter at ${n}`);
    }
  }
  const big = LARGE_SERIES_POINTS + 1;
  for (const build of [lineChart, areaChart]) {
    for (const s of seriesOf(build(panel(), data(big), ctx))) {
      assert.equal(s.sampling, "lttb");
      assert.equal(s.smooth, false);
    }
  }
  for (const s of seriesOf(barChart(panel({ viz: "bar" }), data(big), ctx))) {
    assert.equal(s.large, true);
    assert.equal(s.largeThreshold, LARGE_SERIES_POINTS);
  }
  for (const s of seriesOf(scatterChart(panel({ viz: "scatter" }), data(big), ctx))) {
    assert.equal(s.large, true);
  }
  // Animation is gated on size by ECharts itself, so the motion preference,
  // which EChart applies as `animation`, still wins below it.
  const option = lineChart(panel(), data(big), ctx) as Record<string, unknown>;
  assert.equal(option.animationThreshold, LARGE_SERIES_POINTS);
  assert.equal(option.animation, undefined, "the builder never turns animation on");
});
