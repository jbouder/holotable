import type { EChartsOption } from "echarts";
import type { Panel } from "@/lib/ir";
import { chartPalette } from "@/lib/color/oklch";
import { formatDateTime, type TimeDisplay } from "@/lib/time-display";

export interface PanelData {
  columns: string[];
  rows: Record<string, unknown>[];
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
function normalize(data: PanelData | undefined): PanelData {
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
function toText(value: unknown): string {
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
function toNumber(value: unknown): number {
  if (typeof value === "symbol" || typeof value === "function") return Number.NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

function isNumeric(rows: Record<string, unknown>[], key: string): boolean {
  return rows.some(
    (r) =>
      typeof r[key] === "number" ||
      (r[key] !== null && r[key] !== "" && Number.isFinite(toNumber(r[key]))),
  );
}

function xKey(panel: Panel, data: PanelData): string {
  return panel.query.timeField ?? data.columns[0] ?? "x";
}

function seriesKeys(panel: Panel, data: PanelData): string[] {
  const x = xKey(panel, data);
  return data.columns.filter((c) => c !== x && isNumeric(data.rows, c));
}

/** An ISO-8601-shaped timestamp, the form every driver serializes one to. */
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

function asInstant(value: unknown): Date | null {
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

const BASE: EChartsOption = {
  color: palette,
  grid: { left: 44, right: 16, top: 24, bottom: 28 },
  tooltip: { trigger: "axis", borderRadius: 0 },
  legend: { top: 0, textStyle: { color: "#9aa0aa" } },
  backgroundColor: "transparent",
};

/** One kind's chart: a panel spec and its current (bounded) rows as an ECharts option. */
export type ChartOptionBuilder = (
  panel: Panel,
  data: PanelData,
  display: TimeDisplay,
) => EChartsOption;

/**
 * A builder that is handed only well-formed rows, whatever arrived. Every
 * builder below goes through this, so none of them has to defend itself.
 */
function normalized(build: ChartOptionBuilder): ChartOptionBuilder {
  return (panel, data, display) => build(panel, normalize(data), display);
}

/**
 * Numeric columns against the x key, one series per column: `line`, `area`
 * and `bar`. The x key's labels follow the viewer's time display when it is
 * the panel's time field.
 */
function buildSeries(type: "line" | "bar", area: boolean): ChartOptionBuilder {
  return (panel, data, display) => {
    const x = xKey(panel, data);
    const keys = seriesKeys(panel, data);
    const xValues = data.rows.map((r) => r[x]);
    const categories =
      panel.query.timeField === x
        ? timeAxisLabels(xValues, display)
        : xValues.map(toText);
    return {
      ...BASE,
      xAxis: {
        type: "category",
        data: categories,
        axisLabel: { color: "#9aa0aa", hideOverlap: true },
        axisLine: { lineStyle: { color: "#3a3f4b" } },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: "#9aa0aa" },
        splitLine: { lineStyle: { color: "#2a2f3a" } },
      },
      series: keys.map((k) => ({
        name: k,
        type,
        showSymbol: false,
        smooth: type === "line",
        areaStyle: area ? {} : undefined,
        data: data.rows.map((r) => toNumber(r[k])),
      })),
    };
  };
}

export const lineChart = normalized(buildSeries("line", false));
export const areaChart = normalized(buildSeries("line", true));
export const barChart = normalized(buildSeries("bar", false));
export const scatterChart = normalized((_panel, data) => buildScatter(data));
export const heatmapChart = normalized(buildHeatmap);
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
  return {
    color: palette,
    backgroundColor: "transparent",
    tooltip: { trigger: "item", borderRadius: 0 },
    legend: { top: 0, textStyle: { color: "#9aa0aa" } },
    series: [
      {
        type: "pie",
        radius,
        center: ["50%", "56%"],
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

function buildHeatmap(
  panel: Panel,
  data: PanelData,
  display: TimeDisplay,
): EChartsOption {
  const [xk, yk, vk] = data.columns;
  const xs = [...new Set(data.rows.map((r) => toText(r[xk])))];
  const xLabels = panel.query.timeField === xk ? timeAxisLabels(xs, display) : xs;
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
