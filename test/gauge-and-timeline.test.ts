import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GAUGE_BAR_MAX,
  gaugeBarFit,
  gaugeChart,
  gaugeScale,
  gaugeReadings,
  gaugeShape,
} from "@/components/charts/gauge";
import type { PanelData } from "@/components/charts/options";
import {
  buildStateTimeline,
  HISTORY_CELLS,
  STATE_LANES_MAX,
  stateColor,
  clipRect,
  stateTimelineChart,
  timelineLanesFit,
} from "@/components/charts/state-timeline";
import { Panel } from "@/lib/ir";
import { fallbackToken, tokenHex } from "@/lib/panels/colors";
import { DEFAULT_CHART_THEME, soften } from "@/lib/color/chart-theme";
import { LOCAL_TIME_DISPLAY } from "@/lib/time-display";

/*
 * The gauge (#200) and state-timeline (#201) charts, as the functions that
 * turn rows into what is drawn.
 */

const LAYOUT = { x: 0, y: 0, w: 6, h: 4 };
const CTX = { display: LOCAL_TIME_DISPLAY, theme: DEFAULT_CHART_THEME };

function gauge(options: Record<string, unknown> = {}, format?: "percent"): Panel {
  return Panel.parse({
    id: "g",
    title: "CPU",
    viz: "gauge",
    query: { sourceId: "s", sql: "SELECT 1", timeField: "minute" },
    options,
    format,
    layout: LAYOUT,
  });
}

const THRESHOLDS = [
  { value: 0, color: "success" },
  { value: 70, color: "warning" },
  { value: 90, color: "danger" },
];

/* -------------------------------------------------------------------------- */
/* Gauge                                                                      */
/* -------------------------------------------------------------------------- */

test("a dial shows the last row's value against its limits", () => {
  const data: PanelData = {
    columns: ["minute", "cpu"],
    rows: [
      { minute: "2026-10-04T10:00:00Z", cpu: 40 },
      { minute: "2026-10-04T10:01:00Z", cpu: 75 },
    ],
  };
  const [reading] = gaugeReadings(gauge({ thresholds: THRESHOLDS }, "percent"), data);
  assert.equal(reading.value, 75);
  assert.equal(reading.fraction, 0.75);
  assert.equal(reading.color, "warning");
  assert.match(reading.text, /75/);
});

test("an out-of-range value is drawn clamped, and its text is the true value", () => {
  const panel = gauge({ min: 0, max: 100 });
  const over = gaugeReadings(panel, { columns: ["v"], rows: [{ v: 140 }] })[0];
  assert.equal(over.fraction, 1);
  assert.equal(over.text, "140");
  const under = gaugeReadings(panel, { columns: ["v"], rows: [{ v: -20 }] })[0];
  assert.equal(under.fraction, 0);

  const option = gaugeChart(panel, { columns: ["v"], rows: [{ v: 140 }] }, CTX);
  const series = (option.series as Record<string, unknown>[])[0];
  assert.deepEqual(series.data, [{ value: 100, name: "v" }], "the dial stops at max");
  const detail = series.detail as { formatter: () => string };
  assert.equal(detail.formatter(), "140", "the text does not");
});

test("limits can be columns of the result", () => {
  const panel = gauge({ value: "used", min: 0, max: "quota" });
  const [r] = gaugeReadings(panel, {
    columns: ["used", "quota"],
    rows: [{ used: 30, quota: 60 }],
  });
  assert.equal(r.max, 60);
  assert.equal(r.fraction, 0.5);
});

test("threshold colors come from the token layer", () => {
  const option = gaugeChart(
    gauge({ thresholds: THRESHOLDS }),
    { columns: ["v"], rows: [{ v: 95 }] },
    CTX,
  );
  const series = (option.series as Record<string, { itemStyle: { color: string } }>[])[0];
  assert.equal(series.progress.itemStyle.color, tokenHex("danger", DEFAULT_CHART_THEME));
});

test("bars: the latest row per label, largest first, capped", () => {
  const panel = gauge({ variant: "bar", value: "cpu" });
  const rows = [
    { minute: "t1", host: "a", cpu: 10 },
    { minute: "t1", host: "b", cpu: 50 },
    { minute: "t2", host: "a", cpu: 80 },
  ];
  const readings = gaugeReadings(panel, { columns: ["minute", "host", "cpu"], rows });
  assert.deepEqual(
    readings.map((r) => [r.label, r.value]),
    [
      ["a", 80],
      ["b", 50],
    ],
  );

  const many = Array.from({ length: 80 }, (_, i) => ({ host: `h${i}`, cpu: i }));
  assert.equal(
    gaugeReadings(panel, { columns: ["host", "cpu"], rows: many }).length,
    GAUGE_BAR_MAX,
  );
});

test("a live update merges into the same chart: the shape depends on options alone", () => {
  const panel = gauge({ variant: "bar" });
  const a = gaugeChart(panel, { columns: ["h", "v"], rows: [{ h: "a", v: 1 }] }, CTX);
  const b = gaugeChart(
    panel,
    {
      columns: ["h", "v"],
      rows: [
        { h: "a", v: 2 },
        { h: "b", v: 3 },
      ],
    },
    CTX,
  );
  assert.equal(gaugeShape(panel), "bar");
  // Same series count and type, so `setOption` merges rather than rebuilds.
  const kinds = (o: typeof a) => (o.series as { type: string }[]).map((s) => s.type);
  assert.deepEqual(kinds(a), kinds(b));
  assert.equal(gaugeShape(gauge()), "radial");
});

test("no numeric column, or no rows, draws an empty dial rather than throwing", () => {
  assert.deepEqual(
    gaugeReadings(gauge(), { columns: ["host"], rows: [{ host: "a" }] }),
    [],
  );
  assert.doesNotThrow(() => gaugeChart(gauge(), { columns: [], rows: [] }, CTX));
});

/* -------------------------------------------------------------------------- */
/* State timeline                                                             */
/* -------------------------------------------------------------------------- */

function timeline(options: Record<string, unknown> = {}): Panel {
  return Panel.parse({
    id: "s",
    title: "Status",
    viz: "state-timeline",
    query: { sourceId: "s", sql: "SELECT 1", timeField: "ts" },
    options,
    layout: LAYOUT,
  });
}

const at = (minute: number) => new Date(Date.UTC(2026, 9, 4, 10, minute)).toISOString();
const ms = (minute: number) => Date.UTC(2026, 9, 4, 10, minute);

const ROWS: PanelData = {
  columns: ["ts", "service", "state"],
  rows: [
    { ts: at(0), service: "api", state: "up" },
    { ts: at(0), service: "db", state: "up" },
    { ts: at(5), service: "api", state: "down" },
    { ts: at(7), service: "api", state: "up" },
    { ts: at(9), service: "db", state: "up" },
  ],
};

test("rows become one lane per entity with contiguous spans", () => {
  const window = { from: ms(0), to: ms(10) };
  const t = buildStateTimeline(timeline(), ROWS, window);
  assert.deepEqual(t.lanes, ["api", "db"]);
  assert.deepEqual(
    t.spans.map((s) => [t.lanes[s.lane], s.state, s.start, s.end]),
    [
      ["api", "up", ms(0), ms(5)],
      ["api", "down", ms(5), ms(7)],
      ["api", "up", ms(7), ms(10)],
      // A repeated state is one span, not two.
      ["db", "up", ms(0), ms(10)],
    ],
  );
});

test("the open span ends at the server's window end, not at the viewer's clock", () => {
  const t = buildStateTimeline(timeline(), ROWS, { from: ms(0), to: ms(30) });
  assert.equal(t.spans.at(-1)?.end, ms(30));
  assert.equal(t.to, ms(30));
  // Before the server has said, it ends at the newest row: never Date.now().
  const unsaid = buildStateTimeline(timeline(), ROWS);
  assert.equal(unsaid.spans.at(-1)?.end, ms(9));
});

test("an appended row closes the open span and starts the next", () => {
  const window = { from: ms(0), to: ms(20) };
  const before = buildStateTimeline(timeline(), ROWS, window);
  const after = buildStateTimeline(
    timeline(),
    { ...ROWS, rows: [...ROWS.rows, { ts: at(12), service: "db", state: "down" }] },
    window,
  );
  const db = (t: typeof before) =>
    t.spans.filter((s) => t.lanes[s.lane] === "db").map((s) => [s.state, s.start, s.end]);
  assert.deepEqual(db(before), [["up", ms(0), ms(20)]]);
  assert.deepEqual(db(after), [
    ["up", ms(0), ms(12)],
    ["down", ms(12), ms(20)],
  ]);
});

test("the same state always gets the same color, from the token layer", () => {
  const plain = timeline();
  assert.equal(stateColor("up", plain), "success");
  assert.equal(stateColor("DOWN", plain), "danger");
  assert.equal(stateColor("deploying", plain), fallbackToken("deploying"));
  assert.equal(stateColor("deploying", plain), stateColor("deploying", timeline()));
  const mapped = timeline({ states: [{ state: "up", color: "info" }] });
  assert.equal(stateColor("up", mapped), "info");

  const option = stateTimelineChart(plain, ROWS, CTX);
  const data = (option.series as { data: { itemStyle: { color: string } }[] }[])[0].data;
  // A span is a large area, so it wears its token softened (#647).
  const fill = (token: "success" | "danger") =>
    soften(DEFAULT_CHART_THEME, tokenHex(token, DEFAULT_CHART_THEME));
  assert.equal(data[0].itemStyle.color, fill("success"));
  assert.equal(data[1].itemStyle.color, fill("danger"));
});

test("lanes past the cap are counted and reported, not silently dropped", () => {
  const rows = Array.from({ length: STATE_LANES_MAX + 3 }, (_, i) => ({
    ts: at(0),
    service: `svc-${i}`,
    state: "up",
  }));
  const t = buildStateTimeline(timeline(), { columns: ROWS.columns, rows });
  assert.equal(t.lanes.length, STATE_LANES_MAX);
  assert.equal(t.hiddenLanes, 3);
  const option = stateTimelineChart(timeline(), { columns: ROWS.columns, rows }, CTX);
  assert.equal((option.title as { text: string }).text, "+3 more not shown");
  const none = stateTimelineChart(timeline(), ROWS, CTX);
  assert.equal((none.title as { text: string }).text, "", "cleared, not left behind");
});

test("the history variant is fixed cells across the window", () => {
  const t = buildStateTimeline(timeline({ variant: "history" }), ROWS, {
    from: ms(0),
    to: ms(10),
  });
  const api = t.spans.filter((s) => s.lane === 0);
  assert.equal(api.length, HISTORY_CELLS);
  // A cell's state is the one that held at its middle.
  const cellAt = (minute: number) =>
    api.find((s) => s.start <= ms(minute) && ms(minute) < s.end)?.state;
  assert.equal(cellAt(2), "up");
  assert.equal(cellAt(6), "down");
});

test("named columns win over the guess", () => {
  const data: PanelData = {
    columns: ["ts", "phase", "region"],
    rows: [{ ts: at(0), phase: "build", region: "eu" }],
  };
  const t = buildStateTimeline(timeline({ entity: "region", state: "phase" }), data);
  assert.deepEqual(t.lanes, ["eu"]);
  assert.equal(t.spans[0].state, "build");
});

test("a span is cut to the plot, and one wholly outside it draws nothing", () => {
  // #497: what ECharts' clipRectByRect did, without loading ECharts for it.
  const plot = { x: 10, y: 10, width: 100, height: 50 };
  assert.deepEqual(clipRect({ x: 0, y: 20, width: 50, height: 10 }, plot), {
    x: 10,
    y: 20,
    width: 40,
    height: 10,
  });
  assert.deepEqual(clipRect({ x: 20, y: 20, width: 10, height: 10 }, plot), {
    x: 20,
    y: 20,
    width: 10,
    height: 10,
  });
  assert.equal(clipRect({ x: 120, y: 20, width: 10, height: 10 }, plot), null);
  assert.equal(clipRect({ x: 20, y: 60, width: 10, height: 10 }, plot), null);
});

/*
 * Fitting the panel (#643): a dial's proportions follow its ring, a bar
 * gauge and a timeline draw the rows that fit and count the rest.
 */

test("a dial's ring, value and limits scale with its radius, between floors and ceilings", () => {
  const t = DEFAULT_CHART_THEME;
  // No size: the dial as it always was.
  assert.deepEqual(gaugeScale(undefined, t, "97.2%", "100.0%"), {
    ring: 12,
    value: t.type.value,
    distance: 38,
    limits: true,
  });
  const small = gaugeScale({ width: 180, height: 120 }, t, "97.2%", "100.0%");
  const large = gaugeScale({ width: 460, height: 320 }, t, "97.2%", "100.0%");
  // A small dial's value is smaller than the scale's and its limits go.
  assert.ok(small.value < t.type.value && small.value >= t.type.label, `${small.value}`);
  assert.equal(small.limits, false);
  // A large dial's value grows with it, never past twice the scale's.
  assert.ok(
    large.value > t.type.value && large.value <= 2 * t.type.value,
    `${large.value}`,
  );
  assert.equal(large.limits, true);
  assert.ok(large.ring > small.ring);
  // The ring stays between 6 and 16, the limits just inside it.
  for (const s of [
    small,
    large,
    gaugeScale({ width: 2000, height: 2000 }, t, "1", "1"),
  ]) {
    assert.ok(s.ring >= 6 && s.ring <= 16);
    assert.equal(s.distance, s.ring + 8);
  }
  // Limits that would touch each other are not written (#643: 300×240).
  assert.equal(
    gaugeScale({ width: 280, height: 150 }, t, "54.69%", "100.00%").limits,
    false,
  );
  // A long value is held to the inside of the ring.
  const long = gaugeScale({ width: 460, height: 320 }, t, "1,234,567.89 ms", "100.0%");
  assert.ok(long.value < large.value);
  assert.ok(long.value >= t.type.label);
});

test("a bar gauge draws the largest readings that fit and counts the rest", () => {
  assert.deepEqual(gaugeBarFit(undefined, 12), { shown: 12, thickness: 14 });
  assert.equal(gaugeBarFit({ width: 300, height: 240 }, 4).shown, 4);
  const small = gaugeBarFit({ width: 140, height: 80 }, 4);
  assert.ok(small.shown >= 1 && small.shown < 4, `${small.shown}`);
  assert.ok(small.thickness >= 4 && small.thickness <= 14);
  // Never none, however small.
  assert.equal(gaugeBarFit({ width: 20, height: 20 }, 4).shown, 1);

  const p = Panel.parse({
    id: "g",
    title: "Memory",
    viz: "gauge",
    query: { sourceId: "s", sql: "SELECT 1" },
    options: { variant: "bar" },
    layout: LAYOUT,
  });
  const data: PanelData = {
    columns: ["host", "used"],
    rows: ["a", "b", "c", "d"].map((host, i) => ({ host, used: 10 * (i + 1) })),
  };
  const option = gaugeChart(p, data, { ...CTX, size: { width: 140, height: 80 } }) as {
    yAxis: { data: string[] };
    title: { text: string };
  };
  // The largest first: what is left out is the smallest.
  assert.equal(option.yAxis.data[0], "d");
  assert.equal(option.title.text, `+${4 - option.yAxis.data.length} more`);
  const roomy = gaugeChart(p, data, CTX) as { title: { text: string } };
  assert.equal(roomy.title.text, "");
});

test("a timeline's lanes never vanish: the ones that fit are drawn, the rest counted", () => {
  assert.deepEqual(timelineLanesFit(undefined, 4), { shown: 4, labels: true });
  assert.deepEqual(timelineLanesFit({ width: 400, height: 260 }, 4), {
    shown: 4,
    labels: true,
  });
  // Bars that fit without their names: the names go, the bars stay.
  assert.deepEqual(timelineLanesFit({ width: 200, height: 90 }, 4), {
    shown: 4,
    labels: false,
  });
  const tiny = timelineLanesFit({ width: 140, height: 60 }, 4);
  assert.ok(tiny.shown >= 1 && tiny.shown < 4);

  const p = Panel.parse({
    id: "t",
    title: "Load",
    viz: "state-timeline",
    query: { sourceId: "s", sql: "SELECT 1", timeField: "ts" },
    layout: LAYOUT,
  });
  const data: PanelData = {
    columns: ["ts", "host", "state"],
    rows: ["a", "b", "c", "d"].map((host) => ({
      ts: "2026-10-11T10:00:00Z",
      host,
      state: "ok",
    })),
  };
  const option = stateTimelineChart(p, data, {
    ...CTX,
    size: { width: 140, height: 60 },
  }) as {
    yAxis: { data: string[] };
    title: { text: string };
    series: { data: unknown[] }[];
  };
  assert.ok(option.yAxis.data.length >= 1);
  assert.equal(option.series[0]?.data.length, option.yAxis.data.length);
  assert.equal(option.title.text, `+${4 - option.yAxis.data.length} more not shown`);
});
