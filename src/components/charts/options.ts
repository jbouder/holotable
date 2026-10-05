import type { EChartsOption } from "echarts";
import type { Panel } from "@/lib/ir";
import { chartPalette } from "@/lib/color/oklch";
import { ANNOTATION_COLORS, type Annotation } from "@/lib/annotations";
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
  /**
   * Annotations to draw on a time axis (#68). Undefined draws none and adds
   * nothing to the option; an array, even empty, always sets the marks, so
   * one that leaves is cleared by the merge rather than by a new chart.
   */
  annotations?: readonly Annotation[];
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
  return (panel, data, { display, annotations }) => {
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
      series: keys.map((k, i) => ({
        name: k,
        type,
        showSymbol: false,
        smooth: type === "line",
        areaStyle: area ? {} : undefined,
        ...(o.stacked ? { stack: "total" } : {}),
        // The marks ride on the first series; one per chart is enough.
        ...(i === 0 && annotations && panel.query?.timeField === x
          ? annotationMarks(annotations, xValues, display)
          : {}),
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
 * Annotations as the marks of one series (#68): a line at each point in time,
 * a band over each range, in its kind's token color. The x axis is one
 * category per row, so an instant is placed at the first row at or after it,
 * and a range runs from the last row at or before its start to the first row
 * at or after its end, so it covers its span even between two sparse rows.
 * One wholly before the first row or after the last is off the chart and left
 * out, and a range is clipped to the rows there are. Hovering a mark shows its
 * title and time. Exported for testing.
 */
export function annotationMarks(
  annotations: readonly Annotation[],
  xValues: readonly unknown[],
  display: TimeDisplay,
): { markLine: Record<string, unknown>; markArea: Record<string, unknown> } {
  const times = xValues.map((v) => asInstant(v)?.getTime() ?? Number.NaN);
  const first = times.find(Number.isFinite);
  const last = times.findLast(Number.isFinite);
  const indexAt = (t: number): number => times.findIndex((x) => x >= t);
  const lines: Record<string, unknown>[] = [];
  const areas: Record<string, unknown>[][] = [];
  if (first !== undefined && last !== undefined) {
    for (const a of annotations) {
      const color = tokenHex(ANNOTATION_COLORS[a.kind]);
      // A function, not a template string: a title is untrusted text, and
      // ECharts would read `{a}` in a template as a placeholder.
      // Its own time, not the row it is drawn at, on the viewer's clock.
      const when = formatDateTime(new Date(a.at), display);
      const text = `${a.title}\n${when}`;
      const label = {
        show: false,
        formatter: () => text,
        color,
        position: "insideEndTop",
      };
      const emphasis = { label: { show: true } };
      if (a.endedAt === undefined || a.endedAt === a.at) {
        if (a.at < first || a.at > last) continue;
        lines.push({
          name: a.title,
          xAxis: indexAt(a.at),
          lineStyle: { color, type: "dashed", width: 1 },
          label,
          emphasis,
        });
        continue;
      }
      if (a.endedAt < first || a.at > last) continue;
      const start = Math.max(
        0,
        times.findLastIndex((x) => x <= a.at),
      );
      const endIndex = indexAt(a.endedAt);
      const end = endIndex === -1 ? times.length - 1 : endIndex;
      areas.push([
        {
          name: a.title,
          xAxis: start,
          itemStyle: { color: withAlpha(color, 0.12) },
          label: { ...label, position: "insideTop" },
          emphasis,
        },
        { xAxis: end },
      ]);
    }
  }
  return {
    markLine: { symbol: "none", silent: false, animation: false, data: lines },
    markArea: { silent: false, animation: false, data: areas },
  };
}

/** `#rrggbb` at an opacity. */
function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
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
