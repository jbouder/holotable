import type { EChartsOption } from "echarts";
import {
  type ChartOptionBuilder,
  isNumeric,
  normalized,
  type PanelData,
  toNumber,
  toText,
} from "@/components/charts/options";
import { formatValue } from "@/lib/format";
import { type Panel, panelTimeField } from "@/lib/ir";
import { type ColorToken, tokenHex } from "@/lib/panels/colors";
import { HistogramOptions } from "@/lib/panels/kinds/histogram";
import { numberDisplay, readOptions } from "@/lib/panels/presentation";
import { thresholdColor } from "@/lib/panels/thresholds";

/**
 * The histogram kind (#404): a value distribution as one bar per bucket.
 *
 * Rows are summed per bucket, so a query that groups by a time bucket as well
 * (to take the panel's window) draws the distribution across that window.
 * Numeric buckets are ordered by value; text buckets keep their first order.
 *
 * `cumulative` reads a Prometheus classic histogram: each bucket is an upper
 * bound (`le`, with `+Inf` last) and its count includes every bucket below it,
 * so a bar is its bound's count less the one before. A count that falls is a
 * counter reset inside the window, and is drawn as zero rather than negative.
 */

export const HISTOGRAM_BARS_MAX = 200;
/** Without a threshold step, every bar is the first chart color. */
const DEFAULT_COLOR: ColorToken = "info";

export interface HistogramBar {
  label: string;
  /** The bucket's lower bound, when the buckets are numbers. */
  lower?: number;
  /** The bucket's upper bound, for a cumulative bucket. */
  upper?: number;
  count: number;
  color: ColorToken;
  /** What a click on the bar carries (#373): the bucket and its count. */
  row: Record<string, unknown>;
}

export interface Histogram {
  bars: HistogramBar[];
  bucketKey?: string;
  countKey?: string;
}

/** A Prometheus `le`: a number, or `+Inf`. */
function bound(value: unknown): number {
  const text = toText(value).trim();
  if (text === "+Inf" || text === "Inf" || text === "inf")
    return Number.POSITIVE_INFINITY;
  return toNumber(value);
}

/** What the rows are as bars. Pure, and never throws on odd rows. */
export function histogramBars(panel: Panel, data: PanelData): Histogram {
  const o = readOptions(HistogramOptions, panel.options);
  const timeField = panelTimeField(panel);
  const named = (c: string | undefined) =>
    c && data.columns.includes(c) ? c : undefined;
  const bucketKey =
    named(o.bucket) ??
    (o.cumulative ? named("le") : undefined) ??
    data.columns.find((c) => c !== timeField);
  const countKey =
    named(o.count) ??
    data.columns.find(
      (c) => c !== timeField && c !== bucketKey && isNumeric(data.rows, c),
    );
  if (bucketKey === undefined || countKey === undefined) {
    return { bars: [], bucketKey, countKey };
  }

  // Summed per bucket, in first-seen order.
  const sums = new Map<string, { raw: unknown; count: number }>();
  for (const row of data.rows) {
    const key = toText(row[bucketKey]);
    const n = toNumber(row[countKey]);
    const entry = sums.get(key) ?? { raw: row[bucketKey], count: 0 };
    if (Number.isFinite(n)) entry.count += n;
    sums.set(key, entry);
  }
  const display = numberDisplay(o);
  const label = (n: number) => formatValue(n, panel.format, display);
  const color = (lower: number | undefined) =>
    (lower !== undefined ? thresholdColor(o.thresholds, lower) : undefined) ??
    DEFAULT_COLOR;
  const row = (bucket: unknown, count: number) => ({
    [bucketKey]: bucket,
    [countKey]: count,
  });

  if (o.cumulative) {
    const buckets = [...sums.values()]
      .map((e) => ({ upper: bound(e.raw), raw: e.raw, count: e.count }))
      .filter((b) => !Number.isNaN(b.upper))
      .sort((a, b) => a.upper - b.upper);
    const bars = buckets.map((b, i): HistogramBar => {
      const below = buckets[i - 1];
      const count = Math.max(0, b.count - (below?.count ?? 0));
      const lower = below?.upper;
      return {
        label:
          lower === undefined
            ? `≤ ${label(b.upper)}`
            : b.upper === Number.POSITIVE_INFINITY
              ? `> ${label(lower)}`
              : `${label(lower)}–${label(b.upper)}`,
        lower,
        upper: b.upper,
        count,
        color: color(lower),
        row: row(b.raw, count),
      };
    });
    return { bars: bars.slice(0, HISTOGRAM_BARS_MAX), bucketKey, countKey };
  }

  const entries = [...sums.values()];
  const numeric =
    entries.length > 0 && entries.every((e) => Number.isFinite(toNumber(e.raw)));
  if (numeric) entries.sort((a, b) => toNumber(a.raw) - toNumber(b.raw));
  const bars = entries.map((e): HistogramBar => {
    const lower = numeric ? toNumber(e.raw) : undefined;
    return {
      label: lower !== undefined ? label(lower) : toText(e.raw),
      lower,
      count: e.count,
      color: color(lower),
      row: row(e.raw, e.count),
    };
  });
  return { bars: bars.slice(0, HISTOGRAM_BARS_MAX), bucketKey, countKey };
}

/**
 * Which chart a histogram is: a change of options remounts it (a log axis
 * cannot be merged away), and a data update never does (invariant 11).
 */
export function histogramShape(panel: Panel): string {
  return JSON.stringify(panel.options ?? {});
}

export const histogramChart: ChartOptionBuilder = normalized((panel, data) => {
  const { bars, countKey } = histogramBars(panel, data);
  const o = readOptions(HistogramOptions, panel.options);
  return {
    backgroundColor: "transparent",
    grid: { left: 52, right: 16, top: 16, bottom: 28 },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      borderRadius: 0,
      // The counts are plain numbers; the format is the buckets'.
      valueFormatter: (v: unknown) => formatValue(v),
    },
    xAxis: {
      type: "category",
      data: bars.map((b) => b.label),
      axisLabel: { color: "#9aa0aa", hideOverlap: true },
      axisLine: { lineStyle: { color: "#3a3f4b" } },
    },
    yAxis: {
      type: o.log ? "log" : "value",
      axisLabel: { color: "#9aa0aa" },
      splitLine: { lineStyle: { color: "#2a2f3a" } },
    },
    series: [
      {
        type: "bar",
        name: countKey ?? "count",
        barCategoryGap: "8%",
        data: bars.map((b) => ({
          // A log axis has no zero: an empty bucket is left out of it.
          value: o.log && b.count <= 0 ? null : b.count,
          itemStyle: { color: tokenHex(b.color) },
        })),
      },
    ],
  } satisfies EChartsOption;
});
