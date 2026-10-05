import type { EChartsOption } from "echarts";
import type { Panel } from "@/lib/ir";
import { chartPalette } from "@/lib/color/oklch";
import { formatValue } from "@/lib/format";
import { tokenHex } from "@/lib/panels/colors";
import {
  type LegendPosition,
  type NumberDisplay,
  numberDisplay,
  PieOptions,
  readOptions,
  SeriesOptions,
} from "@/lib/panels/presentation";
import type { ThresholdStep } from "@/lib/panels/thresholds";
import { formatDateTime, type TimeDisplay } from "@/lib/time-display";

export interface PanelData {
  columns: string[];
  rows: Record<string, unknown>[];
  /**
   * The window a one-shot query (`/api/query`) resolved for these rows, in
   * epoch ms. A live dashboard learns it from each `tick` instead.
   */
  window?: { from: number; to: number };
}

const palette = chartPalette();

const EMPTY: PanelData = { columns: [], rows: [] };

/**
 * Rows reach this module from an SSE frame that is `JSON.parse`d and merged,
 * never re-validated against the IR, so a malformed frame or a driver that
 * hands back something unexpected lands here as-is. Nothing below should throw
 * on a shape it did not expect: `PanelErrorBoundary` is the backstop, but a
 * panel that degrades to an empty chart beats one that degrades to a card.
 */
export function normalize(data: PanelData | undefined): PanelData {
  if (!data) return EMPTY;
  return {
    columns: Array.isArray(data.columns)
      ? data.columns.filter((c): c is string => typeof c === "string")
      : [],
    rows: Array.isArray(data.rows)
      ? data.rows.filter(
          (r): r is Record<string, unknown> => typeof r === "object" && r !== null,
        )
      : [],
  };
}

/** `String(v)` throws on a symbol and stringifies objects unhelpfully. */
export function toText(value: unknown): string {
  if (value === null || value === undefined) return "";
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    case "symbol":
    case "function":
      return "";
    default:
      try {
        return JSON.stringify(value) ?? "";
      } catch {
        return "";
      }
  }
}

/** `Number(v)` throws on a symbol; everything else here becomes NaN or a number. */
export function toNumber(value: unknown): number {
  if (typeof value === "symbol" || typeof value === "function") return Number.NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

export function isNumeric(rows: Record<string, unknown>[], key: string): boolean {
  return rows.some(
    (r) =>
      typeof r[key] === "number" ||
      (r[key] !== null && r[key] !== "" && Number.isFinite(toNumber(r[key]))),
  );
}

function xKey(panel: Panel, data: PanelData): string {
  return panel.query?.timeField ?? data.columns[0] ?? "x";
}

function seriesKeys(panel: Panel, data: PanelData): string[] {
  const x = xKey(panel, data);
  return data.columns.filter((c) => c !== x && isNumeric(data.rows, c));
}

/** An ISO-8601-shaped timestamp, the form every driver serializes one to. */
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

export function asInstant(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string" || !TIMESTAMP_RE.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The category labels for a time axis, on the person's clock (#214). Only the
 * labels change: the axis still has one category per row in row order, which
 * is what the brush maps indices back through. A value that is not a
 * timestamp keeps its raw text, and seconds are shown only when some row has
 * them, so a per-minute series does not read `14:05:00, 14:06:00, …`.
 */
export function timeAxisLabels(values: unknown[], display: TimeDisplay): string[] {
  const instants = values.map(asInstant);
  const seconds = instants.some((d) => d !== null && d.getUTCSeconds() !== 0);
  return values.map((v, i) => {
    const d = instants[i];
    return d ? formatDateTime(d, display, { seconds }) : toText(v);
  });
}

const TOOLTIP_AXIS = { trigger: "axis", borderRadius: 0 } as const;

const BASE: EChartsOption = {
  color: palette,
  grid: { left: 44, right: 16, top: 24, bottom: 28 },
  tooltip: TOOLTIP_AXIS,
  legend: { top: 0, textStyle: { color: "#9aa0aa" } },
  backgroundColor: "transparent",
};

const LEGEND_TEXT = { color: "#9aa0aa" };

/** Where the legend goes (#115). `top` is where it always was. */
function legendAt(position: LegendPosition | undefined): EChartsOption["legend"] {
  switch (position) {
    case "none":
      return { show: false };
    case "bottom":
      return { bottom: 0, type: "scroll", textStyle: LEGEND_TEXT };
    case "right":
      return {
        right: 0,
        top: "middle",
        orient: "vertical",
        type: "scroll",
        textStyle: LEGEND_TEXT,
      };
    default:
      return BASE.legend;
  }
}

/** The plot area, making room for the legend where it went and an axis title. */
function gridFor(position: LegendPosition | undefined, axisTitle: boolean) {
  return {
    left: axisTitle ? 64 : 44,
    right: position === "right" ? 128 : 16,
    top: position === "none" || position === "bottom" ? 12 : 24,
    bottom: position === "bottom" ? 52 : 28,
  };
}

/**
 * Threshold steps as a hidden piecewise visual map, so a line's segments, an
 * area's fill and each bar take the color of the step their value is in. Below
 * the first step a value keeps the first series color.
 */
function thresholdMap(steps: readonly ThresholdStep[]): EChartsOption["visualMap"] {
  const pieces = steps.map((step, i) => ({
    gte: step.value,
    ...(steps[i + 1] ? { lt: steps[i + 1].value } : {}),
    color: tokenHex(step.color),
  }));
  return {
    show: false,
    type: "piecewise",
    pieces: [{ lt: steps[0].value, color: palette[0] }, ...pieces],
  };
}

/**
 * The options a series or pie chart was drawn with. When they change the chart
 * is drawn anew, because a merged `setOption` cannot take back a visual map, a
 * stack or an axis bound once set. Only authoring changes them; a data update
 * never does, so it still merges (invariant 11).
 */
export function optionsShape(panel: Panel): string {
  return JSON.stringify(panel.options ?? {});
}

/** What a chart is drawn in, besides its own rows. */
export interface ChartContext {
  /** How the viewer wants times shown (#214). */
  display: TimeDisplay;
  /**
   * The window the rows were selected over, as the server resolved it (epoch
   * ms), once it has said. A chart that runs to "now" ends at `to`, never at
   * the viewer's clock.
   */
  window?: { from: number; to: number };
}

/** One kind's chart: a panel spec and its current (bounded) rows as an ECharts option. */
export type ChartOptionBuilder = (
  panel: Panel,
  data: PanelData,
  ctx: ChartContext,
) => EChartsOption;

/**
 * A builder that is handed only well-formed rows, whatever arrived. Every
 * builder below goes through this, so none of them has to defend itself.
 */
export function normalized(build: ChartOptionBuilder): ChartOptionBuilder {
  return (panel, data, ctx) => build(panel, normalize(data), ctx);
}

/**
 * Numeric columns against the x key, one series per column: `line`, `area`
 * and `bar`. The x key's labels follow the viewer's time display when it is
 * the panel's time field.
 */
function buildSeries(type: "line" | "bar", area: boolean): ChartOptionBuilder {
  return (panel, data, { display }) => {
    const x = xKey(panel, data);
    const keys = seriesKeys(panel, data);
    const xValues = data.rows.map((r) => r[x]);
    const categories =
      panel.query?.timeField === x
        ? timeAxisLabels(xValues, display)
        : xValues.map(toText);
    const o = readOptions(SeriesOptions, panel.options);
    const number = valueFormatter(panel, numberDisplay(o));
    const axis = o.yAxis;
    return {
      ...BASE,
      grid: gridFor(o.legend, axis?.label !== undefined),
      legend: legendAt(o.legend),
      tooltip: { ...TOOLTIP_AXIS, ...(number ? { valueFormatter: number } : {}) },
      ...(o.thresholds?.length ? { visualMap: thresholdMap(o.thresholds) } : {}),
      xAxis: {
        type: "category",
        data: categories,
        axisLabel: { color: "#9aa0aa", hideOverlap: true },
        axisLine: { lineStyle: { color: "#3a3f4b" } },
      },
      yAxis: {
        type: axis?.log ? "log" : "value",
        ...(axis?.min !== undefined ? { min: axis.min } : {}),
        ...(axis?.max !== undefined ? { max: axis.max } : {}),
        ...(axis?.label !== undefined
          ? {
              name: axis.label,
              nameLocation: "middle",
              nameGap: 48,
              nameTextStyle: { color: "#9aa0aa" },
            }
          : {}),
        axisLabel: { color: "#9aa0aa", ...(number ? { formatter: number } : {}) },
        splitLine: { lineStyle: { color: "#2a2f3a" } },
      },
      series: keys.map((k) => ({
        name: k,
        type,
        showSymbol: false,
        smooth: type === "line",
        areaStyle: area ? {} : undefined,
        ...(o.stacked ? { stack: "total" } : {}),
        data: data.rows.map((r) => toNumber(r[k])),
      })),
    };
  };
}

export const lineChart = normalized(buildSeries("line", false));
export const areaChart = normalized(buildSeries("line", true));
export const barChart = normalized(buildSeries("bar", false));
export const scatterChart = normalized((_panel, data) => buildScatter(data));
export const heatmapChart = normalized((panel, data, { display }) =>
  buildHeatmap(panel, data, display),
);
export const pieChart = normalized((panel, data) => buildPie(panel, data, false));
export const donutChart = normalized((panel, data) => buildPie(panel, data, true));

function buildScatter(data: PanelData): EChartsOption {
  const numericColumns = data.columns.filter((column) => isNumeric(data.rows, column));
  const [x, ...seriesKeys] = numericColumns;
  return {
    ...BASE,
    tooltip: { trigger: "item", borderRadius: 0 },
    xAxis: {
      type: "value",
      name: x,
      axisLabel: { color: "#9aa0aa" },
      axisLine: { lineStyle: { color: "#3a3f4b" } },
      splitLine: { lineStyle: { color: "#2a2f3a" } },
    },
    yAxis: {
      type: "value",
      axisLabel: { color: "#9aa0aa" },
      splitLine: { lineStyle: { color: "#2a2f3a" } },
    },
    series: seriesKeys.map((key) => ({
      name: key,
      type: "scatter",
      symbolSize: 8,
      data: data.rows.map((row) => [toNumber(row[x]), toNumber(row[key])]),
    })),
  };
}

/**
 * Pie / donut: a proportional breakdown of one categorical label column against
 * one numeric value column. `donut` is a pie with an inner radius. The category
 * is the panel's x key (timeField or first column); the value is the first
 * numeric column that isn't the category.
 */
function buildPie(panel: Panel, data: PanelData, donut: boolean): EChartsOption {
  const x = xKey(panel, data);
  const valueKey = seriesKeys(panel, data)[0] ?? data.columns.find((c) => c !== x) ?? x;
  const radius = donut ? ["48%", "72%"] : "72%";
  const o = readOptions(PieOptions, panel.options);
  const number = valueFormatter(panel, numberDisplay(o));
  // The pie moves off the legend's side, as the series' grid does.
  const center =
    o.legend === "right"
      ? ["40%", "50%"]
      : o.legend === "bottom" || o.legend === "none"
        ? ["50%", "46%"]
        : ["50%", "56%"];
  return {
    color: palette,
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item",
      borderRadius: 0,
      ...(number ? { valueFormatter: number } : {}),
    },
    legend: legendAt(o.legend),
    series: [
      {
        type: "pie",
        radius,
        center,
        data: data.rows.map((r) => ({
          name: toText(r[x]),
          value: toNumber(r[valueKey]) || 0,
        })),
        label: { color: "#9aa0aa" },
        labelLine: { lineStyle: { color: "#3a3f4b" } },
      },
    ],
  };
}

/**
 * How a chart writes a value, once the panel was given number options (#115).
 * Without them a chart writes values as it always has, `panel.format` or not.
 */
function valueFormatter(
  panel: Panel,
  display: NumberDisplay | undefined,
): ((value: unknown) => string) | undefined {
  if (!display) return undefined;
  return (value) => formatValue(value, panel.format, display);
}

function buildHeatmap(
  panel: Panel,
  data: PanelData,
  display: TimeDisplay,
): EChartsOption {
  const [xk, yk, vk] = data.columns;
  const xs = [...new Set(data.rows.map((r) => toText(r[xk])))];
  const xLabels = panel.query?.timeField === xk ? timeAxisLabels(xs, display) : xs;
  const ys = [...new Set(data.rows.map((r) => toText(r[yk])))];
  const values = data.rows.map((r) => [
    xs.indexOf(toText(r[xk])),
    ys.indexOf(toText(r[yk])),
    toNumber(r[vk]) || 0,
  ]);
  const max = Math.max(1, ...values.map((v) => v[2]));
  return {
    backgroundColor: "transparent",
    tooltip: { position: "top" },
    grid: { left: 60, right: 16, top: 24, bottom: 40 },
    xAxis: { type: "category", data: xLabels, axisLabel: { color: "#9aa0aa" } },
    yAxis: { type: "category", data: ys, axisLabel: { color: "#9aa0aa" } },
    visualMap: {
      min: 0,
      max,
      calculable: true,
      orient: "horizontal",
      left: "center",
      bottom: 0,
      inRange: { color: [palette[5], palette[0], palette[3]] },
      textStyle: { color: "#9aa0aa" },
    },
    series: [{ type: "heatmap", data: values, progressive: 1000 }],
  };
}
