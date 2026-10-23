import { panelTimeField } from "@/lib/ir";
import type { EChartsOption } from "echarts";
import type { Panel } from "@/lib/ir";
import {
  type ChartTheme,
  inkOn,
  seriesColor,
  soften,
  withAlpha,
} from "@/lib/color/chart-theme";
import {
  areaFill,
  axis as axisStyle,
  barCorners,
  blockLabel,
  categoryAxis,
  block,
  legend,
  seriesLine,
  shared,
  stackOrder,
  text,
  tickLabel,
  tooltip,
} from "@/components/charts/style";
import { ANNOTATION_COLORS, type Annotation } from "@/lib/annotations";
import { formatValue } from "@/lib/format";
import { fillHex, tokenHex } from "@/lib/panels/colors";
import {
  type LegendPosition,
  type NumberDisplay,
  numberDisplay,
  PieOptions,
  readOptions,
  SeriesOptions,
  type ValueFormat,
} from "@/lib/panels/presentation";
import type { ThresholdStep } from "@/lib/panels/thresholds";
import { formatDateTime, type TimeDisplay } from "@/lib/time-display";
import type { Truncation } from "@/lib/truncation";
import {
  axisDensity,
  axisNumber,
  type ChartSize,
  legendRows,
  logLabelStep,
  logTicks,
  textWidth,
} from "@/components/charts/size";

export interface PanelData {
  columns: string[];
  rows: Record<string, unknown>[];
  /**
   * The window a one-shot query (`/api/query`) resolved for these rows, in
   * epoch ms. A live dashboard learns it from each `tick` instead.
   */
  window?: { from: number; to: number };
  /** Where this result was cut short, server or browser side (#486). */
  truncated?: Truncation;
}

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
  return panelTimeField(panel) ?? data.columns[0] ?? "x";
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
export function timeAxisLabels(
  values: unknown[],
  display: TimeDisplay,
  { date = true }: { date?: boolean } = {},
): string[] {
  const instants = values.map(asInstant);
  const seconds = instants.some((d) => d !== null && d.getUTCSeconds() !== 0);
  return values.map((v, i) => {
    const d = instants[i];
    return d ? formatDateTime(d, display, { seconds, date }) : toText(v);
  });
}

/** The smallest and largest positive values in these columns: a log axis's span. */
export function positiveRange(
  rows: Record<string, unknown>[],
  keys: readonly string[],
): { low: number; high: number } {
  let low = Number.POSITIVE_INFINITY;
  let high = 0;
  for (const row of rows) {
    for (const key of keys) {
      const n = toNumber(row[key]);
      if (n > 0) {
        low = Math.min(low, n);
        high = Math.max(high, n);
      }
    }
  }
  return high > 0 ? { low, high } : { low: 0, high: 0 };
}

/** The shared tooltip, following the axis. */
function axisTooltip(theme: ChartTheme) {
  return { ...tooltip(theme), trigger: "axis" as const };
}

const GRID = { left: 44, right: 16, top: 24, bottom: 28 };

/** What every cartesian chart starts from. */
/**
 * Past this many points a series is large (#491): a line is sampled
 * (largest-triangle-three-buckets) and drawn straight, bars and scatter use
 * ECharts' large mode, and no series animates. Below it nothing changes. The
 * accessible table beside the chart always lists the panel's own rows,
 * never the sampled ones.
 */
export const LARGE_SERIES_POINTS = 500;

/** The series fields that make a large series cheap to paint; none for a small one. */
export function largeSeries(type: "line" | "bar" | "scatter", points: number) {
  if (points <= LARGE_SERIES_POINTS) return {};
  if (type === "line") return { sampling: "lttb" as const, smooth: false };
  return { large: true, largeThreshold: LARGE_SERIES_POINTS };
}

function base(theme: ChartTheme): EChartsOption {
  return {
    ...shared(theme),
    // A series this long does not animate, whatever the motion preference
    // allows; the preference still turns animation off below it (#491).
    animationThreshold: LARGE_SERIES_POINTS,
    grid: GRID,
    tooltip: axisTooltip(theme),
    legend: legendAt(undefined, theme),
  };
}

/**
 * Where the legend goes (#115). `top` is where it always was. `shown` false
 * hides it where it is (#643), so a later size can show it again by merging
 * `show` alone.
 */
function legendAt(
  position: LegendPosition | undefined,
  theme: ChartTheme,
  shown = true,
): EChartsOption["legend"] {
  const style = legend(theme);
  switch (position) {
    case "none":
      return { show: false };
    case "bottom":
      return { show: shown, bottom: 0, type: "scroll", ...style };
    case "right":
      return {
        show: shown,
        right: 0,
        top: "middle",
        orient: "vertical",
        type: "scroll",
        ...style,
      };
    default:
      return { show: shown, top: 0, ...style };
  }
}

/** A line of legend entries, and the gap below it. */
const LEGEND_ROW_PX = 24;
/** The most of a chart's height a legend at the top may take. */
const LEGEND_SHARE = 0.3;
/** The gutter a legend on the right takes, and the narrowest chart it is kept on. */
const LEGEND_RIGHT_PX = 128;
const LEGEND_RIGHT_MIN_WIDTH = 360;

/**
 * Where the legend goes at this size, and how many lines it takes (#643).
 * With room it is where the panel put it. On a small panel a top legend that
 * wraps makes the plot room for each line it wraps to, a bottom or right one
 * is kept only while it fits on one line or in its gutter, and one that does
 * not fit is not drawn at all, never drawn over the plot or paged: the
 * tooltip names every series under the pointer, and the table beside the
 * chart lists them.
 */
export function legendLayout(
  position: LegendPosition | undefined,
  size: ChartSize | undefined,
  names: readonly string[],
  textPx: number,
): { position: LegendPosition; rows: number } {
  const at = position ?? "top";
  if (!size || at === "none") return { position: at, rows: at === "none" ? 0 : 1 };
  const hidden = { position: "none" as const, rows: 0 };
  if (at === "right") {
    const fits =
      size.width >= LEGEND_RIGHT_MIN_WIDTH &&
      names.length * LEGEND_ROW_PX <= size.height &&
      names.every((n) => textWidth(n, textPx) + 17 <= LEGEND_RIGHT_PX);
    return fits ? { position: at, rows: 1 } : hidden;
  }
  const rows = legendRows(size.width, names, textPx);
  if (at === "bottom") return rows <= 1 ? { position: at, rows } : hidden;
  return rows * LEGEND_ROW_PX <= size.height * LEGEND_SHARE
    ? { position: at, rows }
    : hidden;
}

/** The plot area, making room for the legend where it went and an axis title. */
function gridFor(position: LegendPosition | undefined, axisTitle: boolean, rows = 1) {
  return {
    left: axisTitle ? 64 : 44,
    right: position === "right" ? LEGEND_RIGHT_PX : 16,
    top:
      position === "none" || position === "bottom"
        ? 12
        : 24 + Math.max(0, rows - 1) * LEGEND_ROW_PX,
    bottom: position === "bottom" ? 52 : 28,
  };
}

/**
 * Threshold steps as a hidden piecewise visual map, so a line's segments, an
 * area's fill and each bar take the color of the step their value is in. Below
 * the first step a value keeps the first series color.
 */
function thresholdMap(
  steps: readonly ThresholdStep[],
  theme: ChartTheme,
): EChartsOption["visualMap"] {
  const pieces = steps.map((step, i) => ({
    gte: step.value,
    ...(steps[i + 1] ? { lt: steps[i + 1].value } : {}),
    color: fillHex(step.color, theme),
  }));
  return {
    show: false,
    type: "piecewise",
    pieces: [{ lt: steps[0].value, color: seriesColor(theme, 0) }, ...pieces],
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
  /**
   * The page around the series (#502): axis and legend text, lines and
   * grid, read off `<html>` so a chart follows the theme as the page does.
   */
  theme: ChartTheme;
  /**
   * How big the chart is drawn, stepped (#643), once it has been laid out.
   * A kind fits its ticks, labels and text to it through the rules in
   * `size.ts`; undefined draws the chart as it would with room. A new step
   * is merged into the same chart, so a builder that reads it sets every
   * field it varies in each of its branches.
   */
  size?: ChartSize;
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
  return (panel, data, { display, annotations, theme, size }) => {
    const x = xKey(panel, data);
    const keys = seriesKeys(panel, data);
    const xValues = data.rows.map((r) => r[x]);
    const categories =
      panelTimeField(panel) === x
        ? timeAxisLabels(xValues, display)
        : xValues.map(toText);
    const o = readOptions(SeriesOptions, panel.options);
    const number = valueFormatter(panel, numberDisplay(o));
    const axis = o.yAxis;
    // Fewer ticks, written compactly, as the panel gets small (#643).
    const density = axisDensity(size);
    const placed = legendLayout(o.legend, size, keys, theme.type.axis);
    const positive = axis?.log ? positiveRange(data.rows, keys) : { low: 0, high: 0 };
    return {
      ...base(theme),
      grid: gridFor(placed.position, axis?.label !== undefined, placed.rows),
      legend: legendAt(o.legend, theme, placed.position !== "none"),
      tooltip: { ...axisTooltip(theme), ...(number ? { valueFormatter: number } : {}) },
      ...(o.thresholds?.length ? { visualMap: thresholdMap(o.thresholds, theme) } : {}),
      // A category axis, deliberately (#491): the brush maps its span to row
      // indices (`brushedRange`), the crosshair group moves its peers by
      // index, and a datum click reads the row at its index. A time axis
      // would need all three to work by timestamp. See architecture/scaling.
      xAxis: {
        ...categoryAxis(theme),
        type: "category",
        data: categories,
      },
      yAxis: {
        ...axisStyle(theme),
        type: axis?.log ? "log" : "value",
        // A log axis keeps ECharts' own steps: fewer would be decades apart.
        splitNumber: axis?.log ? undefined : density.y,
        ...(axis?.min !== undefined ? { min: axis.min } : {}),
        ...(axis?.max !== undefined ? { max: axis.max } : {}),
        ...(axis?.label !== undefined
          ? {
              name: axis.label,
              nameLocation: "middle",
              nameGap: 48,
              nameTextStyle: text(theme),
            }
          : {}),
        axisLabel: tickLabel(
          theme,
          axis?.log
            ? logTicks(
                logLabelStep(size, positive.low, positive.high),
                axisNumber(panel.format, numberDisplay(o), density),
              )
            : axisNumber(panel.format, numberDisplay(o), density),
        ),
      },
      series: keys.map((k, i) => ({
        name: k,
        type,
        showSymbol: false,
        smooth: type === "line",
        ...(type === "line"
          ? { lineStyle: seriesLine(theme, area && o.stacked === true) }
          : {}),
        // Alone, an area fades toward the axis; in a stack, each band is
        // near solid, parted from the one above by its line (#647).
        ...(area
          ? {
              areaStyle: areaFill(
                theme,
                o.thresholds?.length ? undefined : seriesColor(theme, i),
                o.stacked === true,
              ),
              ...(o.stacked ? stackOrder(i, keys.length) : {}),
            }
          : {}),
        ...(type === "bar" && !o.stacked ? { itemStyle: barCorners(theme) } : {}),
        ...largeSeries(type, data.rows.length),
        ...(o.stacked ? { stack: "total" } : {}),
        // The marks ride on the first series; one per chart is enough.
        ...(i === 0 && annotations && panelTimeField(panel) === x
          ? annotationMarks(annotations, xValues, display, theme)
          : {}),
        data: data.rows.map((r) => toNumber(r[k])),
        // The corners and the fill widen the inferred union past what the
        // option type narrows by `type`; each member is a line or a bar.
      })) as EChartsOption["series"],
    };
  };
}

export const lineChart = normalized(buildSeries("line", false));
export const areaChart = normalized(buildSeries("line", true));
export const barChart = normalized(buildSeries("bar", false));
export const scatterChart = normalized((panel, data, { theme, size }) =>
  buildScatter(panel, data, theme, size),
);
export const heatmapChart = normalized((panel, data, { display, theme, size }) =>
  buildHeatmap(panel, data, display, theme, size),
);
export const pieChart = normalized((panel, data, { theme, size }) =>
  buildPie(panel, data, false, theme, size),
);
export const donutChart = normalized((panel, data, { theme, size }) =>
  buildPie(panel, data, true, theme, size),
);

/** What a scatter's y axis is called when it carries several series of one format. */
const FORMAT_UNIT: Partial<Record<ValueFormat, string>> = {
  bytes: "bytes",
  percent: "%",
  ms: "ms",
};

/** Below this size a scatter's axis names give their room to the plot (#643). */
const SCATTER_NAMES_PX = { width: 240, height: 180 };

/**
 * Scatter: the first numeric column across, every other numeric column up,
 * one series each (#640). Both axes are named in their middle: x by its
 * column, y by its one column, or by the panel's unit when several series
 * share it. One series needs no legend, since the y axis already says what it
 * is; several keep theirs. The panel's format writes both axes' ticks.
 */
function buildScatter(
  panel: Panel,
  data: PanelData,
  theme: ChartTheme,
  size: ChartSize | undefined,
): EChartsOption {
  const numericColumns = data.columns.filter((column) => isNumeric(data.rows, column));
  const [x, ...seriesKeys] = numericColumns;
  const one = seriesKeys.length === 1;
  const yName = one ? seriesKeys[0] : panel.format && FORMAT_UNIT[panel.format];
  // Both axes are value axes: fewer ticks, written compactly, on a small
  // panel, and the names go before the plot is squeezed for them (#643).
  const density = axisDensity(size);
  const ticks =
    density.compact || !panel.format
      ? axisNumber(panel.format, undefined, density)
      : (v: number) => formatValue(v, panel.format);
  // Several series keep a legend while it fits (#643); one needs none.
  const placed = one
    ? { position: "none" as const, rows: 0 }
    : legendLayout(undefined, size, seriesKeys, theme.type.axis);
  const named = {
    x: !size || size.height >= SCATTER_NAMES_PX.height,
    y: !size || size.width >= SCATTER_NAMES_PX.width,
  };
  // An empty name, not none: a merge would keep a name the last size drew.
  const name = (label: string | undefined, show: boolean) =>
    label === undefined
      ? {}
      : {
          name: show ? label : "",
          nameLocation: "middle" as const,
          // From the tick labels, which ECharts moves the name clear of.
          nameGap: 12,
          nameTextStyle: text(theme),
        };
  return {
    ...base(theme),
    // The grid holds its tick labels and both names inside the chart.
    grid: {
      left: 8,
      right: 16,
      top: placed.position === "none" ? 12 : 32 + (placed.rows - 1) * LEGEND_ROW_PX,
      bottom: 8,
      outerBoundsMode: "same",
      outerBoundsContain: "all",
    },
    legend: one
      ? { show: false }
      : legendAt(undefined, theme, placed.position !== "none"),
    tooltip: { ...tooltip(theme), trigger: "item" },
    xAxis: {
      ...axisStyle(theme),
      type: "value",
      splitNumber: density.x,
      ...name(x, named.x),
      axisLabel: tickLabel(theme, ticks),
    },
    yAxis: {
      ...axisStyle(theme),
      type: "value",
      splitNumber: density.y,
      ...name(yName, named.y),
      axisLabel: tickLabel(theme, ticks),
    },
    series: seriesKeys.map((key) => ({
      name: key,
      type: "scatter",
      symbolSize: 8,
      itemStyle: { opacity: 0.85 },
      ...largeSeries("scatter", data.rows.length),
      data: data.rows.map((row) => [toNumber(row[x]), toNumber(row[key])]),
    })),
  };
}

/** A slice label's leader line: its two runs, as `buildPie` draws them. */
const PIE_LINE_RUNS = [12, 10] as const;
/**
 * What a slice label takes beside the pie besides its text: the line, the
 * gap between line and text (ECharts' 5) and the margin it keeps from the
 * chart's edge (its `bleedMargin`, 10 on a pie of any size).
 */
const PIE_LABEL_LINE_PX = PIE_LINE_RUNS[0] + PIE_LINE_RUNS[1] + 5 + 10;
/** The outer radius of a pie, as a share of half its shorter side, with no wrapped legend. */
const PIE_OUTER = 0.72;
/** A donut's inner radius as a share of its outer one. */
const DONUT_HOLE = 48 / 72;
/** Without a size, a slice is wide enough to carry its share at a tenth of the whole. */
const PIE_SHARE_MIN = 0.1;
/** The space a share keeps on each side inside its slice. */
const PIE_SHARE_PAD_PX = 4;

/**
 * Where a pie's legend goes at a size, and whether its slices carry their
 * names outside (#643, #638). With room, the legend goes where the panel put
 * it. A right legend that does not fit moves under the pie, and one under or
 * over it that would take more than a quarter of the height is dropped. The
 * legend is never paged.
 *
 * A legend already names the slices, so a pie with one draws no outside
 * labels and no leader lines: the legend says the names, the tooltip the
 * values, and a large slice its share inside (`pieShares`). With no legend,
 * asked for or dropped, the slices are named outside, but only while the
 * longest name fits whole beside the pie: never cut to `er…`, and never a
 * line with nothing at its end. Below that the tooltip and the table name
 * them, and the large slices still carry their shares.
 */
export function pieLayout(
  position: LegendPosition | undefined,
  size: ChartSize | undefined,
  names: readonly string[],
  textPx: number,
): { position: LegendPosition; rows: number; labels: boolean } {
  const asked = position ?? "top";
  if (!size) {
    const none = asked === "none";
    return { position: asked, rows: none ? 0 : 1, labels: none };
  }
  const across = (at: "top" | "bottom") => {
    const rows = legendRows(size.width, names, textPx);
    return rows * LEGEND_ROW_PX <= size.height * 0.25 ? { position: at, rows } : null;
  };
  const placed =
    asked === "none"
      ? null
      : asked === "right"
        ? legendLayout("right", size, names, textPx).position === "right"
          ? { position: "right" as const, rows: 1 }
          : across("bottom")
        : across(asked);
  if (placed) return { ...placed, labels: false };
  // The room beside the pie for a label and its line.
  const radius = PIE_OUTER * (Math.min(size.width, size.height) / 2);
  const beside = (size.width - 2 * radius) / 2;
  const longest = names.reduce((a, b) => (b.length > a.length ? b : a), "");
  const labels = textWidth(longest, textPx) + PIE_LABEL_LINE_PX <= beside;
  return { position: "none", rows: 0, labels };
}

/**
 * Which slices carry their share (`42%`) inside them (#638): those wide and
 * deep enough, at the pie's drawn radius, for the text with a little room
 * around it. ECharts writes an inside label level, halfway across the slice
 * (the ring of a donut), so the slice has to be at least the text's width
 * along its arc there and across its depth. Without a size, a tenth of the
 * whole or more.
 */
export function pieShares(
  values: readonly number[],
  size: ChartSize | undefined,
  outer: number,
  donut: boolean,
  textPx: number,
): boolean[] {
  const total = values.reduce((sum, v) => sum + (v > 0 ? v : 0), 0);
  if (!(total > 0)) return values.map(() => false);
  if (!size) return values.map((v) => v / total >= PIE_SHARE_MIN);
  const r = outer * (Math.min(size.width, size.height) / 2);
  const r0 = donut ? r * DONUT_HOLE : 0;
  const mid = (r + r0) / 2;
  const need = textWidth("88%", textPx) + 2 * PIE_SHARE_PAD_PX;
  if (r - r0 < Math.max(need, textPx + 2 * PIE_SHARE_PAD_PX)) {
    return values.map(() => false);
  }
  return values.map((v) => v > 0 && (v / total) * 2 * Math.PI * mid >= need);
}

/** A share as a slice carries it: whole percent. */
function sharePercent(params: unknown): string {
  const percent = (params as { percent?: number }).percent ?? 0;
  return `${Math.round(percent)}%`;
}

/** A pie's legend where `pieLayout` put it, every placement field said, never paged. */
function pieLegend(position: LegendPosition, theme: ChartTheme): EChartsOption["legend"] {
  const at = {
    top: { top: 0, bottom: undefined, left: "center", right: undefined },
    bottom: { top: undefined, bottom: 0, left: "center", right: undefined },
    right: { top: "middle", bottom: undefined, left: undefined, right: 0 },
    none: { top: 0, bottom: undefined, left: "center", right: undefined },
  }[position];
  return {
    show: position !== "none",
    type: "plain",
    orient: position === "right" ? "vertical" : "horizontal",
    ...at,
    ...legend(theme),
  };
}

/**
 * Pie / donut: a proportional breakdown of one categorical label column against
 * one numeric value column. `donut` is a pie with an inner radius. The category
 * is the panel's x key (timeField or first column); the value is the first
 * numeric column that isn't the category.
 */
function buildPie(
  panel: Panel,
  data: PanelData,
  donut: boolean,
  theme: ChartTheme,
  size: ChartSize | undefined,
): EChartsOption {
  const x = xKey(panel, data);
  const valueKey = seriesKeys(panel, data)[0] ?? data.columns.find((c) => c !== x) ?? x;
  const o = readOptions(PieOptions, panel.options);
  const number = valueFormatter(panel, numberDisplay(o));
  const names = data.rows.map((r) => toText(r[x]));
  const placed = pieLayout(o.legend, size, names, theme.type.axis);
  // The pie moves off the legend's side, as the series' grid does, and
  // shrinks by the share of the height a wrapped legend takes.
  const share = size && placed.rows > 1 ? (placed.rows * LEGEND_ROW_PX) / size.height : 0;
  const center =
    placed.position === "right"
      ? ["40%", "50%"]
      : placed.position === "bottom" || placed.position === "none"
        ? ["50%", `${Math.round(46 - share * 50)}%`]
        : ["50%", `${Math.round(56 + share * 50)}%`];
  const outer = Math.round(100 * PIE_OUTER * (1 - share));
  const radius = donut
    ? [`${Math.round(outer * DONUT_HOLE)}%`, `${outer}%`]
    : `${outer}%`;
  const values = data.rows.map((r) => toNumber(r[valueKey]) || 0);
  // A slice's fill, as `color` hands it out: the softened palette, in turn.
  const fills = theme.series.map((c) => soften(theme, c));
  const fillOf = (i: number) => fills[i % fills.length] ?? theme.text;
  const inside = blockLabel(theme);
  const shares = placed.labels
    ? values.map(() => false)
    : pieShares(values, size, outer / 100, donut, inside.fontSize);
  const longest = names.reduce((a, b) => (b.length > a.length ? b : a), "");
  // Each field is said in both answers, since a size step merges (#643).
  const label = placed.labels
    ? {
        ...text(theme),
        show: true,
        position: "outside" as const,
        formatter: "{b}",
        // Wide enough for the longest name, so ECharts never cuts one to
        // `…`; `pieLayout` labels only when that fits beside the pie.
        width: textWidth(longest, theme.type.axis),
        overflow: "none" as const,
      }
    : {
        ...inside,
        color: theme.text,
        show: false,
        position: "inside" as const,
        formatter: sharePercent,
        width: textWidth("100%", inside.fontSize),
        overflow: "none" as const,
      };
  return {
    ...shared(theme),
    // A slice is a large area: its color is softened, as a treemap node's is.
    color: fills,
    tooltip: {
      ...tooltip(theme),
      trigger: "item",
      ...(number ? { valueFormatter: number } : {}),
    },
    legend: pieLegend(placed.position, theme),
    series: [
      {
        type: "pie",
        radius,
        center,
        data: data.rows.map((r, i) => ({
          name: toText(r[x]),
          value: values[i],
          // A share written on its slice reads on the softened fill (AA).
          label: placed.labels
            ? { show: true, color: theme.text }
            : { show: shares[i], color: inkOn(fillOf(i)) },
        })),
        // Slices part by a hair of surface, with the page's corners.
        itemStyle: block(theme, { edge: 2 }),
        label,
        // A line only to a name: never one with nothing at its end.
        labelLine: {
          show: placed.labels,
          length: PIE_LINE_RUNS[0],
          length2: PIE_LINE_RUNS[1],
          lineStyle: { color: theme.line },
        },
        avoidLabelOverlap: true,
        // A label that would overlap another hides with its line (#643).
        labelLayout: { hideOverlap: true },
        // A sliver's label would only collide with its neighbors'.
        minShowLabelAngle: placed.labels ? 4 : 0,
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
  theme: ChartTheme,
): { markLine: Record<string, unknown>; markArea: Record<string, unknown> } {
  const times = xValues.map((v) => asInstant(v)?.getTime() ?? Number.NaN);
  const first = times.find(Number.isFinite);
  const last = times.findLast(Number.isFinite);
  const indexAt = (t: number): number => times.findIndex((x) => x >= t);
  const lines: Record<string, unknown>[] = [];
  const areas: Record<string, unknown>[][] = [];
  if (first !== undefined && last !== undefined) {
    for (const a of annotations) {
      const color = tokenHex(ANNOTATION_COLORS[a.kind], theme);
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

/** The strip on a heatmap's right edge for its color scale, its handles and their values. */
const HEATMAP_SCALE_ROOM = 72;
/** The color scale's bar at its longest, and its shortest. */
const HEATMAP_SCALE_MAX = 120;
const HEATMAP_SCALE_MIN = 32;
/** What an upright scale spends down the chart besides its bar: a value at each end. */
const HEATMAP_SCALE_CHROME = 56;
/** Below this width the scale is slim, so the cells keep the width. */
export const HEATMAP_SLIM_BELOW = 240;
/** Below this many pixels a cell is drawn without the hair of surface parting it. */
const HEATMAP_EDGE_MIN_CELL = 4;

/** How a heatmap's color scale is drawn at a size (#643). */
export interface HeatmapScale {
  /** No drag handles: the range written at the bar's ends, in a narrower strip. */
  slim: boolean;
  /** The bar's length (`itemHeight`). */
  length: number;
  /** The strip on the right the grid leaves for it. */
  strip: number;
}

/**
 * How a heatmap's color scale is drawn at a size (#643). Upright in its strip
 * on the right (#639), 120px long where there is room and the chart's height
 * less the values at its ends on a short panel, never under 32px. On a narrow
 * panel the 72px strip would leave the cells a sliver, so the scale goes slim:
 * no drag handles, the range written above and below the bar, in a strip as
 * wide as the largest value and as long as the height leaves after it. `maxText` is that value as the scale writes it,
 * at `textPx`.
 */
export function heatmapScale(
  size: ChartSize | undefined,
  maxText: string,
  textPx: number,
): HeatmapScale {
  const clamp = (px: number) =>
    Math.max(HEATMAP_SCALE_MIN, Math.min(HEATMAP_SCALE_MAX, Math.round(px)));
  if (!size) return { slim: false, length: HEATMAP_SCALE_MAX, strip: HEATMAP_SCALE_ROOM };
  if (size.width < HEATMAP_SLIM_BELOW) {
    // The values above and below the bar, and their gaps, come first: a
    // short panel's slim bar goes down to 12px rather than push them out.
    return {
      slim: true,
      length: Math.max(
        12,
        Math.min(HEATMAP_SCALE_MAX, size.height - 2 * (textPx + 10) - 12),
      ),
      strip: Math.max(12, textWidth(maxText, textPx)) + 18,
    };
  }
  return {
    slim: false,
    length: clamp(size.height - HEATMAP_SCALE_CHROME),
    strip: HEATMAP_SCALE_ROOM,
  };
}

function buildHeatmap(
  panel: Panel,
  data: PanelData,
  display: TimeDisplay,
  theme: ChartTheme,
  size: ChartSize | undefined,
): EChartsOption {
  const [xk, yk, vk] = data.columns;
  const xs = [...new Set(data.rows.map((r) => toText(r[xk])))];
  const timed = panelTimeField(panel) === xk;
  const xLabels = timed ? timeAxisLabels(xs, display) : xs;
  // A narrow heatmap's ticks write the time alone; the tooltip keeps the day (#643).
  const narrow = timed && size !== undefined && size.width < HEATMAP_SLIM_BELOW;
  const ticks = narrow ? timeAxisLabels(xs, display, { date: false }) : undefined;
  const ys = [...new Set(data.rows.map((r) => toText(r[yk])))];
  const values = data.rows.map((r) => [
    xs.indexOf(toText(r[xk])),
    ys.indexOf(toText(r[yk])),
    toNumber(r[vk]) || 0,
  ]);
  const max = Math.max(1, ...values.map((v) => v[2]));
  // The scale writes its range as its handles do, to whole numbers.
  const top = String(Math.round(max));
  const scale = heatmapScale(size, top, theme.type.axis);
  // A cell under a few pixels wide would be all edge: it goes (#643).
  const plot = size
    ? size.width -
      16 -
      scale.strip -
      textWidth(
        ys.reduce((a, b) => (b.length > a.length ? b : a), ""),
        theme.type.axis,
      )
    : Number.POSITIVE_INFINITY;
  const cell = plot / Math.max(1, xs.length);
  return {
    ...shared(theme),
    tooltip: { ...tooltip(theme), position: "top" },
    // The color scale stands on the right edge, upright, in a strip of its
    // own: at the bottom it shared the time labels' strip and its handles
    // covered them (#639). The grid holds the row labels whatever they say.
    // A narrow one's strip is as wide as its slim scale (#643). The axis
    // labels are held inside the chart, the first and last too.
    grid: {
      left: 8,
      right: scale.strip,
      top: 16,
      bottom: 8,
      outerBoundsMode: "same",
      outerBoundsContain: "all",
    },
    xAxis: {
      ...categoryAxis(theme),
      type: "category",
      data: xLabels,
      axisLabel: {
        ...categoryAxis(theme).axisLabel,
        formatter: ticks ? (_: string, i: number) => ticks[i] ?? "" : undefined,
      },
    },
    yAxis: { ...categoryAxis(theme), type: "category", data: ys },
    visualMap: {
      min: 0,
      max,
      // A slim scale writes its range at its ends instead of on handles.
      calculable: !scale.slim,
      text: scale.slim ? [top, "0"] : ["", ""],
      orient: "vertical",
      right: 0,
      top: "middle",
      itemWidth: 12,
      itemHeight: scale.length,
      inRange: { color: [...theme.sequential] },
      textStyle: text(theme),
    },
    series: [
      {
        type: "heatmap",
        data: values,
        progressive: 1000,
        // Cells part by a hair of surface, with the page's corners.
        itemStyle: block(theme, { cap: 3, edge: cell < HEATMAP_EDGE_MIN_CELL ? 0 : 1 }),
      },
    ],
  };
}
