import { test } from "node:test";
import assert from "node:assert/strict";
import type { Panel } from "@/lib/ir";
import {
  areaChart,
  barChart,
  LARGE_SERIES_POINTS,
  legendLayout,
  lineChart,
  heatmapScale,
  pieLayout,
  pieShares,
  type PanelData,
  pieChart,
  scatterChart,
} from "@/components/charts/options";
import {
  axisDensity,
  axisNumber,
  labelBudget,
  legendRows,
  logLabelStep,
  logTicks,
  nodeLabels,
  SIZE_STEP,
  sameSize,
  sizeStep,
  textWidth,
} from "@/components/charts/size";
import { PANEL_RENDERERS } from "@/components/panels/registry";
import { DEFAULT_CHART_THEME } from "@/lib/color/chart-theme";
import { LOCAL_TIME_DISPLAY } from "@/lib/time-display";
import { formatValue } from "@/lib/format";

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
      "sankey",
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

/**
 * A line's curve (#665): straight by default at every length, a smooth curve
 * only while the series is small, a step at any length. Both fields are said
 * on every line, so changing the curve merges into the same chart.
 */
test("a line joins its samples straight, smooth or in steps, as its curve says", () => {
  const ctx = { display: LOCAL_TIME_DISPLAY, theme: DEFAULT_CHART_THEME };
  const data = (n: number): PanelData => ({
    columns: ["ts", "v", "w"],
    rows: Array.from({ length: n }, (_, i) => ({
      ts: new Date(Date.UTC(2026, 9, 11, 0, 0, i)).toISOString(),
      v: i % 17,
      w: i % 5,
    })),
  });
  type Series = Record<string, unknown>;
  const drawn = (
    build: typeof lineChart,
    options: Record<string, unknown> | undefined,
    n: number,
  ) =>
    (build(panel(options ? { options } : {}), data(n), ctx).series as Series[]).map(
      (s) => [s.smooth, s.step],
    );
  const big = LARGE_SERIES_POINTS + 1;
  for (const build of [lineChart, areaChart]) {
    for (const n of [20, big]) {
      for (const s of drawn(build, undefined, n))
        assert.deepEqual(s, [false, false], `${n}`);
      for (const s of drawn(build, { curve: "straight" }, n))
        assert.deepEqual(s, [false, false]);
      for (const s of drawn(build, { curve: "step" }, n))
        assert.deepEqual(s, [false, "end"]);
    }
    for (const s of drawn(build, { curve: "smooth" }, 20))
      assert.deepEqual(s, [true, false]);
    for (const s of drawn(build, { curve: "smooth" }, big))
      assert.deepEqual(s, [false, false]);
  }
  // Thresholds color every curve by value, and a stacked area stacks with each.
  for (const curve of ["straight", "smooth", "step"]) {
    const thresholds = [
      { value: 0, color: "success" },
      { value: 10, color: "danger" },
    ];
    const lit = lineChart(panel({ options: { curve, thresholds } }), data(20), ctx);
    assert.ok(lit.visualMap, `${curve}: thresholds map the line`);
    const stack = seriesOf(
      areaChart(panel({ options: { curve, stacked: true } }), data(20), ctx),
    );
    for (const s of stack) assert.equal(s.stack, "total", `${curve}: stacked`);
  }
  function seriesOf(option: { series?: unknown }) {
    return option.series as Series[];
  }
  // A bar has no curve, whatever the options say.
  for (const s of barChart(
    panel({ viz: "bar", options: { curve: "step" } }),
    data(20),
    ctx,
  ).series as Series[]) {
    assert.equal("step" in s, false);
    assert.equal("smooth" in s, false);
  }
});

/*
 * Charts fit their text to the panel (#643): the chart reports a stepped
 * size, and these rules turn it into what a kind draws. With no size every
 * rule answers with the chart as it was before.
 */

test("a chart's size is stepped, so a drag rebuilds it a few times, not every frame", () => {
  assert.deepEqual(sizeStep(219, 181), { width: 200, height: 180 });
  assert.ok(sameSize(sizeStep(201, 181), sizeStep(219, 199)));
  assert.ok(!sameSize(sizeStep(219, 181), sizeStep(221, 181)));
  // A box that is not drawn has no size to fit.
  assert.equal(sizeStep(0, 200), undefined);
  assert.equal(sizeStep(300, 0), undefined);
  // The smallest step is one step, never zero.
  assert.deepEqual(sizeStep(5, 5), { width: SIZE_STEP, height: SIZE_STEP });
});

test("a value axis has as many ticks as lines of text fit, and writes them compactly when narrow", () => {
  assert.deepEqual(axisDensity(undefined), { y: 5, x: 5, compact: false });
  const small = axisDensity({ width: 140, height: 80 });
  assert.deepEqual(small, { y: 2, x: 2, compact: true });
  const mid = axisDensity({ width: 280, height: 180 });
  assert.equal(mid.y, 4);
  assert.equal(mid.x, 3);
  assert.equal(mid.compact, true);
  // Never more than ECharts' own five, never fewer than two.
  assert.deepEqual(axisDensity({ width: 1600, height: 900 }), {
    y: 5,
    x: 5,
    compact: false,
  });
  assert.equal(axisDensity({ width: 20, height: 20 }).y, 2);
});

test("a narrow axis writes large numbers compactly, through the panel's format and options", () => {
  const narrow = axisDensity({ width: 200, height: 120 });
  const wide = axisDensity({ width: 600, height: 300 });
  // Wide and plain: ECharts' own ticks, as before.
  assert.equal(axisNumber(undefined, undefined, wide), undefined);
  assert.equal(axisNumber(undefined, { decimals: 0 }, wide)?.(60_000_000), "60,000,000");
  const plain = axisNumber(undefined, undefined, narrow);
  assert.equal(plain?.(60_000_000), "60M");
  // Small numbers keep their digits: compact would write 0.25 as 0.3.
  assert.equal(plain?.(0.25), "0.25");
  assert.equal(plain?.(750), "750");
  // Bytes always carry their unit.
  assert.equal(axisNumber("bytes", undefined, narrow)?.(512), "512 B");
  // The panel's unit stays; its decimals do not merge two ticks into one.
  const ms = axisNumber("ms", { decimals: 0 }, narrow);
  assert.notEqual(ms?.(1500), ms?.(2000));
  assert.match(ms?.(1500) ?? "", /^1\.5K ms$/);
  assert.equal(axisNumber(undefined, { unit: "req" }, narrow)?.(1200), "1.2K req");
  // A panel that said `compact: false` keeps its full numbers.
  assert.equal(
    axisNumber(undefined, { compact: false, decimals: 0 }, narrow)?.(60_000_000),
    "60,000,000",
  );
});

test("labels fit while each has its line, and are left to hover below that", () => {
  assert.deepEqual(labelBudget(undefined, 12, { need: 14 }), {
    show: true,
    room: Number.POSITIVE_INFINITY,
  });
  assert.equal(labelBudget({ width: 200, height: 120 }, 0, { need: 14 }).show, true);
  assert.deepEqual(labelBudget({ width: 200, height: 120 }, 4, { need: 14 }), {
    show: true,
    room: 30,
  });
  assert.equal(labelBudget({ width: 200, height: 120 }, 10, { need: 14 }).show, false);
  // Along the width, less what the chart spends before its labels.
  const across = labelBudget({ width: 200, height: 120 }, 4, {
    along: "width",
    need: 60,
    chrome: 40,
  });
  assert.deepEqual(across, { show: false, room: 40 });
});

test("a legend makes room for the lines it wraps to, or is not drawn, never over the plot", () => {
  const names = ["ok", "client_errors", "server_errors"];
  assert.deepEqual(legendLayout(undefined, undefined, names, 11), {
    position: "top",
    rows: 1,
  });
  assert.equal(legendRows(1000, names, 11), 1);
  assert.ok(legendRows(140, names, 11) > 1);
  // Wide enough to wrap into the room it is given.
  assert.deepEqual(legendLayout("top", { width: 200, height: 260 }, names, 11), {
    position: "top",
    rows: legendRows(200, names, 11),
  });
  // Too many lines for a short chart: hidden; the tooltip names the series.
  assert.equal(
    legendLayout("top", { width: 140, height: 80 }, names, 11).position,
    "none",
  );
  assert.equal(
    legendLayout("bottom", { width: 140, height: 200 }, names, 11).position,
    "none",
  );
  assert.equal(
    legendLayout("right", { width: 300, height: 200 }, names, 11).position,
    "none",
  );
  assert.equal(
    legendLayout("right", { width: 400, height: 200 }, names, 11).position,
    "right",
  );
  assert.equal(
    legendLayout("none", { width: 900, height: 600 }, names, 11).position,
    "none",
  );

  // And the series chart draws what the layout says.
  const ctx = { display: LOCAL_TIME_DISPLAY, theme: DEFAULT_CHART_THEME };
  const data: PanelData = {
    columns: ["ts", ...names],
    rows: [{ ts: "2026-10-11T10:00:00Z", ok: 1, client_errors: 2, server_errors: 3 }],
  };
  const small = lineChart(panel(), data, { ...ctx, size: { width: 140, height: 80 } });
  assert.equal((small.legend as { show: boolean }).show, false);
  assert.equal((small.grid as { top: number }).top, 12);
  const y = small.yAxis as { splitNumber: number; axisLabel: { hideOverlap: boolean } };
  assert.equal(y.splitNumber, 2);
  assert.equal(y.axisLabel.hideOverlap, true);
  const roomy = lineChart(panel(), data, ctx);
  assert.equal((roomy.legend as { show: boolean }).show, true);
  assert.equal((roomy.yAxis as { splitNumber: number }).splitNumber, 5);
});

test("a short log axis labels every other decade, so six decades never touch", () => {
  // ECharts draws a log axis a decade a tick whatever splitNumber says.
  assert.equal(logLabelStep(undefined, 1, 100_000), 1);
  assert.equal(logLabelStep({ width: 400, height: 260 }, 1, 100_000), 1);
  const step = logLabelStep({ width: 200, height: 120 }, 2, 50_000);
  assert.ok(step >= 2, `step ${step}`);
  const write = logTicks(step, undefined);
  assert.equal(write?.(1), "1");
  assert.equal(write?.(10 ** step), formatValue(10 ** step));
  assert.equal(write?.(10), "");
  assert.equal(logTicks(1, undefined), undefined);
});

test("node labels are full, smaller, names alone, or left to hover, never half-drawn", () => {
  const fit = (width: number, height: number, across = 3, down = 4) =>
    nodeLabels(
      { width, height },
      {
        across,
        down,
        widest: "worker-queue  23.9K",
        widestName: "worker-queue",
        textPx: 11,
      },
    );
  assert.deepEqual(
    nodeLabels(undefined, {
      across: 9,
      down: 9,
      widest: "x",
      widestName: "x",
      textPx: 11,
    }),
    { show: true, values: true, small: false },
  );
  assert.deepEqual(fit(900, 600), { show: true, values: true, small: false });
  const narrower = fit(380, 600);
  assert.equal(narrower.show, true);
  assert.equal(narrower.values, false, "the name alone where the value does not fit");
  assert.deepEqual(fit(140, 80), { show: false, values: false, small: true });
  // Too many rows for the height hides them whatever the width.
  assert.equal(fit(2000, 100, 3, 12).show, false);
});

test("a pie's legend moves under it or gives way to labels, and is never paged", () => {
  const names = ["worker", "api", "web"];
  assert.deepEqual(pieLayout("right", undefined, names, 11), {
    position: "right",
    rows: 1,
    labels: false,
  });
  // A right legend on a narrow pie goes underneath.
  assert.equal(
    pieLayout("right", { width: 300, height: 240 }, names, 11).position,
    "bottom",
  );
  assert.equal(
    pieLayout("right", { width: 460, height: 300 }, names, 11).position,
    "right",
  );
  // No room for any legend: the slices' own labels, if they fit beside it.
  const many = Array.from({ length: 12 }, (_, i) => `service-${i}`);
  const dropped = pieLayout("bottom", { width: 200, height: 120 }, many, 11);
  assert.equal(dropped.position, "none");
  // Labels never cut: a long name on a small pie is left to the tooltip.
  assert.equal(
    pieLayout("none", { width: 140, height: 80 }, ["a-very-long-service-name"], 11)
      .labels,
    false,
  );
  assert.equal(pieLayout("none", { width: 600, height: 300 }, names, 11).labels, true);
  // The legend itself is plain at every size: wrapped, never paged.
  const option = pieChart(
    panel({ viz: "pie", options: { legend: "bottom" } }),
    { columns: ["name", "v"], rows: names.map((name, i) => ({ name, v: i + 1 })) },
    {
      display: LOCAL_TIME_DISPLAY,
      theme: DEFAULT_CHART_THEME,
      size: { width: 200, height: 120 },
    },
  ) as { legend: { type: string } };
  assert.equal(option.legend.type, "plain");
});

test("a pie with a legend has no outside labels; without one, every label is whole", () => {
  // #638: the legend already names the slices, so outside labels repeated
  // it, and ECharts cut the ones that did not fit to `…` and left leader
  // lines with nothing at their end.
  const names = ["worker", "api", "web"];
  const data = {
    columns: ["name", "v"],
    rows: names.map((name, i) => ({ name, v: (i + 1) * 10 })),
  };
  interface Drawn {
    legend: { show: boolean };
    series: {
      label: { show: boolean; position: string; overflow: string; width: number };
      labelLine: { show: boolean };
      data: { label: { show: boolean } }[];
    }[];
  }
  const draw = (legend: string, size?: { width: number; height: number }) =>
    pieChart(
      panel({
        viz: "donut",
        query: { sourceId: "s", sql: "SELECT 1" },
        options: { legend },
      }),
      data,
      {
        display: LOCAL_TIME_DISPLAY,
        theme: DEFAULT_CHART_THEME,
        size,
      },
    ) as unknown as Drawn;
  for (const size of [
    undefined,
    { width: 600, height: 300 },
    { width: 300, height: 240 },
  ]) {
    for (const legend of ["top", "bottom", "right"]) {
      const option = draw(legend, size);
      assert.equal(option.legend.show, true, `${legend} ${JSON.stringify(size)}`);
      const [series] = option.series;
      assert.equal(series.label.position, "inside", legend);
      assert.equal(series.labelLine.show, false, legend);
    }
  }
  // No legend, room beside the pie: names outside, each whole, a line to each.
  const named = draw("none", { width: 600, height: 300 }).series[0];
  assert.equal(named.label.position, "outside");
  assert.equal(named.label.overflow, "none", "never cut to …");
  assert.ok(named.label.width >= textWidth("worker", DEFAULT_CHART_THEME.type.axis));
  assert.equal(named.labelLine.show, true);
  // No room: no outside label, so no line, and the shares inside instead.
  const narrow = draw("none", { width: 140, height: 80 }).series[0];
  assert.equal(narrow.label.position, "inside");
  assert.equal(narrow.labelLine.show, false);
});

test("a slice carries its share only where the text fits inside it", () => {
  const size = { width: 400, height: 300 };
  assert.deepEqual(pieShares([60, 30, 9, 1], undefined, 0.72, false, 12), [
    true,
    true,
    false,
    false,
  ]);
  // At a pie's middle a tenth of the whole is too short an arc for `9%`...
  assert.deepEqual(pieShares([60, 30, 9, 1], size, 0.72, false, 12), [
    true,
    true,
    false,
    false,
  ]);
  // ...and further out, along a donut's ring, it is long enough.
  assert.deepEqual(pieShares([60, 30, 9, 1], size, 0.72, true, 12), [
    true,
    true,
    true,
    false,
  ]);
  // Too small a ring for any: none, rather than text over the edges.
  assert.deepEqual(pieShares([50, 50], { width: 80, height: 60 }, 0.72, true, 12), [
    false,
    false,
  ]);
  assert.deepEqual(pieShares([0, 0], size, 0.72, false, 12), [false, false]);
});

test("a heatmap's color scale shortens on a short panel and goes slim on a narrow one", () => {
  const at = (width: number, height: number) => heatmapScale({ width, height }, "88", 11);
  assert.deepEqual(heatmapScale(undefined, "88", 11), {
    slim: false,
    length: 120,
    strip: 72,
  });
  assert.deepEqual(at(400, 260), { slim: false, length: 120, strip: 72 });
  assert.deepEqual(at(280, 120), { slim: false, length: 64, strip: 72 });
  assert.deepEqual(at(280, 60), { slim: false, length: 32, strip: 72 });
  // Narrow: no handles, a strip as wide as the largest value, so the cells keep the room.
  const narrow = at(200, 120);
  assert.equal(narrow.slim, true);
  assert.ok(narrow.strip < 72 && narrow.length >= 32, JSON.stringify(narrow));
});
