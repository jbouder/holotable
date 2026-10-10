import assert from "node:assert/strict";
import { test } from "node:test";
import {
  histogramBars,
  histogramChart,
  histogramShape,
} from "@/components/charts/histogram";
import type { PanelData } from "@/components/charts/options";
import { Panel } from "@/lib/ir";
import { tokenHex } from "@/lib/panels/colors";
import { LOCAL_TIME_DISPLAY } from "@/lib/time-display";

/*
 * The histogram (#404): rows summed into buckets, and a Prometheus classic
 * histogram's cumulative `le` buckets differenced into bars.
 */

const LAYOUT = { x: 0, y: 0, w: 6, h: 4 };
const CTX = { display: LOCAL_TIME_DISPLAY };
const T = (m: number) => `2026-10-09T10:0${m}:00Z`;

function histogram(
  options: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Panel {
  return Panel.parse({
    id: "h",
    title: "Latency",
    viz: "histogram",
    query: { sourceId: "s", sql: "SELECT 1", timeField: "minute" },
    options,
    layout: LAYOUT,
    ...extra,
  });
}

/** Two minutes of a latency distribution, bucketed by 50 ms. */
const PER_MINUTE: PanelData = {
  columns: ["minute", "bucket", "requests"],
  rows: [
    { minute: T(0), bucket: 50, requests: 10 },
    { minute: T(0), bucket: 0, requests: 30 },
    { minute: T(0), bucket: 500, requests: 1 },
    { minute: T(1), bucket: 0, requests: 20 },
    { minute: T(1), bucket: 50, requests: 15 },
  ],
};

test("rows are summed per bucket across the window, ordered by bucket", () => {
  const { bars, bucketKey, countKey } = histogramBars(histogram(), PER_MINUTE);
  assert.equal(bucketKey, "bucket");
  assert.equal(countKey, "requests");
  assert.deepEqual(
    bars.map((b) => [b.lower, b.count]),
    [
      [0, 50],
      [50, 25],
      [500, 1],
    ],
  );
});

test("bucket labels follow the panel's format; text buckets keep their order", () => {
  const ms = histogramBars(histogram({ decimals: 0 }, { format: "ms" }), PER_MINUTE);
  assert.deepEqual(
    ms.bars.map((b) => b.label),
    ["0 ms", "50 ms", "500 ms"],
  );
  const text = histogramBars(histogram(), {
    columns: ["size", "n"],
    rows: [
      { size: "small", n: 4 },
      { size: "large", n: 1 },
      { size: "medium", n: 2 },
    ],
  });
  assert.deepEqual(
    text.bars.map((b) => [b.label, b.lower]),
    [
      ["small", undefined],
      ["large", undefined],
      ["medium", undefined],
    ],
  );
});

test("thresholds color a bar from its bucket's lower bound", () => {
  const steps = [
    { value: 0, color: "success" },
    { value: 500, color: "danger" },
  ];
  const { bars } = histogramBars(histogram({ thresholds: steps }), PER_MINUTE);
  assert.deepEqual(
    bars.map((b) => b.color),
    ["success", "success", "danger"],
  );
  const option = histogramChart(histogram({ thresholds: steps }), PER_MINUTE, CTX);
  const series = (option.series as { data: { itemStyle: { color: string } }[] }[])[0];
  assert.equal(series?.data[2]?.itemStyle.color, tokenHex("danger"));
});

/** `sum by (le) (increase(x_bucket[1h]))` as an instant query answers it. */
const PROM: PanelData = {
  columns: ["le", "value"],
  rows: [
    { le: "+Inf", value: 100 },
    { le: "0.1", value: 60 },
    { le: "0.5", value: 90 },
    { le: "0.05", value: 20 },
  ],
};

test("cumulative buckets are differenced into bars, +Inf last", () => {
  const { bars } = histogramBars(histogram({ cumulative: true, unit: "s" }), PROM);
  assert.deepEqual(
    bars.map((b) => [b.label, b.count]),
    [
      ["≤ 0.05 s", 20],
      ["0.05 s–0.1 s", 40],
      ["0.1 s–0.5 s", 30],
      ["> 0.5 s", 10],
    ],
  );
  // `le` is found without being named.
  assert.equal(histogramBars(histogram({ cumulative: true }), PROM).bucketKey, "le");
});

test("a cumulative count that falls is a reset, drawn as zero", () => {
  const { bars } = histogramBars(histogram({ cumulative: true }), {
    columns: ["le", "value"],
    rows: [
      { le: "1", value: 10 },
      { le: "2", value: 4 },
    ],
  });
  assert.deepEqual(
    bars.map((b) => b.count),
    [10, 0],
  );
});

test("a log axis leaves empty buckets out instead of drawing log(0)", () => {
  const option = histogramChart(
    histogram({ cumulative: true, log: true }),
    {
      columns: ["le", "value"],
      rows: [
        { le: "1", value: 5 },
        { le: "2", value: 5 },
      ],
    },
    CTX,
  );
  assert.equal((option.yAxis as { type: string }).type, "log");
  const series = (option.series as { data: { value: number | null }[] }[])[0];
  assert.deepEqual(
    series?.data.map((d) => d.value),
    [5, null],
  );
});

test("named columns win over the guess", () => {
  const data: PanelData = {
    columns: ["route", "bucket", "requests", "bytes"],
    rows: [{ route: "/a", bucket: 10, requests: 3, bytes: 900 }],
  };
  const guessed = histogramBars(histogram(), data);
  assert.deepEqual([guessed.bucketKey, guessed.countKey], ["route", "bucket"]);
  const named = histogramBars(histogram({ bucket: "bucket", count: "bytes" }), data);
  assert.deepEqual(
    named.bars.map((b) => [b.lower, b.count]),
    [[10, 900]],
  );
});

test("no rows, or no count column, draw no bars rather than throwing", () => {
  assert.deepEqual(histogramBars(histogram(), { columns: [], rows: [] }).bars, []);
  assert.deepEqual(
    histogramBars(histogram(), { columns: ["a"], rows: [{ a: "x" }] }).bars,
    [],
  );
  assert.doesNotThrow(() => histogramChart(histogram(), { columns: [], rows: [] }, CTX));
});

test("a data update merges into the same chart: the shape depends on options alone", () => {
  const panel = histogram({ log: true });
  assert.equal(histogramShape(panel), histogramShape(panel));
  assert.notEqual(histogramShape(panel), histogramShape(histogram()));
});

test("the options refuse an unknown field and a raw color", () => {
  const ok = (options: Record<string, unknown>) =>
    Panel.safeParse({
      id: "h",
      title: "Latency",
      viz: "histogram",
      query: { sourceId: "s", sql: "SELECT 1" },
      options,
      layout: LAYOUT,
    }).success;
  assert.equal(ok({ cumulative: true, log: true, bucket: "le" }), true);
  assert.equal(ok({ markLine: 500 }), false);
  assert.equal(ok({ thresholds: [{ value: 1, color: "#ff0000" }] }), false);
});
