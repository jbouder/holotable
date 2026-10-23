import { type ChartTheme, withAlpha } from "@/lib/color/chart-theme";
import {
  barCorners,
  shared,
  text as textStyle,
  tooltip,
  valueText,
} from "@/components/charts/style";
import { panelTimeField } from "@/lib/ir";
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
import { type ChartSize, labelBudget, textWidth } from "@/components/charts/size";
import type { Panel } from "@/lib/ir";
import { type ColorToken, fillHex } from "@/lib/panels/colors";
import { GaugeOptions } from "@/lib/panels/kinds/gauge";
import { thresholdColor } from "@/lib/panels/thresholds";

/**
 * The gauge kind (#200): one value against its limits.
 *
 * `radial` reads the last row, the way `stat` does. `bar` reads one bar per
 * label: the latest row for each, sorted largest first, at most
 * {@link GAUGE_BAR_MAX}. A value outside its limits is drawn clamped to them,
 * and its text is always the true value.
 */

export const GAUGE_BAR_MAX = 50;
const DEFAULT_MIN = 0;
const DEFAULT_MAX = 100;
/** Below every threshold step, or with none: the primary accent. */
const DEFAULT_COLOR: ColorToken = "info";

export interface GaugeReading {
  label: string;
  value: number;
  min: number;
  max: number;
  /** Where the value sits between min and max, clamped to 0..1. */
  fraction: number;
  /** The true value, formatted per `panel.format`. */
  text: string;
  color: ColorToken;
  /** The result row the reading was read from: what a click on it drills into (#373). */
  row: Record<string, unknown>;
}

/** A panel's gauge options, or the defaults when they do not parse. */
export function gaugeOptions(panel: Panel): GaugeOptions {
  const parsed = GaugeOptions.safeParse(panel.options ?? {});
  return parsed.success ? parsed.data : {};
}

function bound(
  spec: number | string | undefined,
  row: Record<string, unknown>,
  fallback: number,
): number {
  if (typeof spec === "number") return spec;
  if (spec === undefined) return fallback;
  const n = toNumber(row[spec]);
  return Number.isFinite(n) ? n : fallback;
}

/** The readings a gauge panel shows for these rows. Pure. */
export function gaugeReadings(panel: Panel, data: PanelData): GaugeReading[] {
  const options = gaugeOptions(panel);
  const timeField = panelTimeField(panel);
  const boundColumns = [options.min, options.max].filter(
    (b): b is string => typeof b === "string",
  );
  const valueKey =
    (options.value && data.columns.includes(options.value) ? options.value : undefined) ??
    data.columns.find(
      (c) => c !== timeField && !boundColumns.includes(c) && isNumeric(data.rows, c),
    );
  if (valueKey === undefined) return [];

  const reading = (row: Record<string, unknown>, label: string): GaugeReading | null => {
    const value = toNumber(row[valueKey]);
    if (!Number.isFinite(value)) return null;
    const min = bound(options.min, row, DEFAULT_MIN);
    let max = bound(options.max, row, DEFAULT_MAX);
    if (max <= min) max = min + 1;
    const fraction = Math.min(1, Math.max(0, (value - min) / (max - min)));
    return {
      label,
      value,
      min,
      max,
      fraction,
      text: formatValue(value, panel.format, options),
      color: thresholdColor(options.thresholds, value) ?? DEFAULT_COLOR,
      row,
    };
  };

  if (options.variant !== "bar") {
    const last = data.rows[data.rows.length - 1];
    const one = last ? reading(last, valueKey) : null;
    return one ? [one] : [];
  }

  // The label is the first column that is not the time, the value or a
  // bound, and is not a number; failing that, the first column at all.
  const labelKey =
    data.columns.find(
      (c) =>
        c !== timeField &&
        c !== valueKey &&
        !boundColumns.includes(c) &&
        !isNumeric(data.rows, c),
    ) ?? data.columns.find((c) => c !== valueKey);
  // The latest row per label, so a time series of many hosts reads as now.
  const latest = new Map<string, Record<string, unknown>>();
  for (const row of data.rows) {
    latest.set(labelKey === undefined ? valueKey : toText(row[labelKey]), row);
  }
  return [...latest]
    .map(([label, row]) => reading(row, label))
    .filter((r): r is GaugeReading => r !== null)
    .sort((a, b) => b.value - a.value)
    .slice(0, GAUGE_BAR_MAX);
}

/**
 * The dial's track: the threshold steps as bands, faint, so the value's own
 * color reads as where it is now and the bands as where the lines are.
 */
function bands(
  panel: Panel,
  min: number,
  max: number,
  theme: ChartTheme,
): [number, string][] {
  const steps = gaugeOptions(panel).thresholds ?? [];
  const track = theme.track;
  if (steps.length === 0) return [[1, track]];
  const stops: [number, string][] = [];
  let color: string = track;
  for (const step of steps) {
    const at = (step.value - min) / (max - min);
    if (at > 0 && at < 1) stops.push([at, color]);
    if (at < 1) color = withAlpha(fillHex(step.color, theme), theme.faint);
  }
  stops.push([1, color]);
  return stops;
}

/** How a dial is drawn at a size: its ring, its value and its limits. */
export interface GaugeScale {
  /** The ring's width. */
  ring: number;
  /** The value's text size. */
  value: number;
  /** How far inside the ring the limits are written. */
  distance: number;
  /** Write the min and max at the ends of the ring. */
  limits: boolean;
}

/** The dial's radius as a share of the chart's shorter side (`radius: "92%"`). */
const DIAL_RADIUS = 0.46;
/** Below this radius the limits are left to the tooltip-less dial's table. */
const LIMITS_MIN_RADIUS = 56;

/** A dial's limits sit this far inside its ring. */
const LIMITS_INSET = 8;
/** The least gap kept between two limits, and between a limit and the value. */
const LIMITS_GAP = 6;
/** The angle below the horizontal the ring ends at (`startAngle: 215`, `endAngle: -35`). */
const RING_END = (35 * Math.PI) / 180;

/**
 * A dial's proportions at a size (#643): the ring, the value's text and the
 * limits' distance as shares of the ring's radius, between floors and
 * ceilings, so a small dial's value never covers its ring and a large one's
 * is not lost in it. The value is as large as a third of the radius, no
 * wider than the inside of the ring, and between the label size and twice
 * the scale's value size. The limits sit just inside the ring's ends, and are
 * written only on a ring big enough and only where they touch neither each
 * other nor the value; the table still says them. No size is the dial as it
 * was drawn before.
 *
 * ECharts writes a limit `distance` inside the ring's outer edge (the hidden
 * split line has no length or gap of its own here), aligned inward: the min's
 * left edge and the max's right edge are at the ring's ends.
 */
export function gaugeScale(
  size: ChartSize | undefined,
  theme: ChartTheme,
  valueText: string,
  limitText: string,
): GaugeScale {
  if (!size) return { ring: 12, value: theme.type.value, distance: 38, limits: true };
  const radius = DIAL_RADIUS * Math.min(size.width, size.height);
  const ring = Math.round(Math.min(16, Math.max(6, radius * 0.1)));
  const inside = Math.max(0, radius - ring);
  const chars = Math.max(1, valueText.length);
  const value = Math.round(
    Math.min(
      theme.type.value * 2,
      Math.max(theme.type.label, Math.min(radius / 3, (1.4 * inside) / (chars * 0.62))),
    ),
  );
  const distance = ring + LIMITS_INSET;
  const reach = Math.max(0, radius - distance);
  // The limits' inner edges, from the centre, and how far below it they sit;
  // the value sits 8% of the radius below the centre.
  const inner = Math.cos(RING_END) * reach - textWidth(limitText, theme.type.axis);
  const below = Math.sin(RING_END) * reach - 0.08 * radius;
  const eachOther = 2 * inner >= LIMITS_GAP;
  const ofValue =
    inner - textWidth(valueText, value) / 2 >= LIMITS_GAP ||
    Math.abs(below) - (value + theme.type.axis) / 2 >= LIMITS_GAP / 2;
  return {
    ring,
    value,
    distance,
    limits: radius >= LIMITS_MIN_RADIUS && eachOther && ofValue,
  };
}

function radial(
  panel: Panel,
  reading: GaugeReading | undefined,
  theme: ChartTheme,
  size: ChartSize | undefined,
): EChartsOption {
  const min = reading?.min ?? DEFAULT_MIN;
  const max = reading?.max ?? DEFAULT_MAX;
  // Clamped for the drawing; the text below says what it really is.
  const drawn = reading ? Math.min(max, Math.max(min, reading.value)) : min;
  const text = reading?.text ?? "—";
  const limit = (v: number) => formatValue(v, panel.format, gaugeOptions(panel));
  const longer = [limit(min), limit(max)].sort((a, b) => b.length - a.length)[0] ?? "";
  const scale = gaugeScale(size, theme, text, longer);
  return {
    ...shared(theme),
    tooltip: { show: false },
    series: [
      {
        type: "gauge",
        min,
        max,
        startAngle: 215,
        endAngle: -35,
        radius: "92%",
        center: ["50%", "58%"],
        progress: {
          show: true,
          width: scale.ring,
          roundCap: theme.radius > 0,
          itemStyle: { color: fillHex(reading?.color ?? DEFAULT_COLOR, theme) },
        },
        axisLine: {
          roundCap: theme.radius > 0,
          lineStyle: { width: scale.ring, color: bands(panel, min, max, theme) },
        },
        pointer: { show: false },
        anchor: { show: false },
        axisTick: { show: false },
        // No length or gap of its own: the limits' distance is all of their inset.
        splitLine: { show: false, length: 0, distance: 0 },
        splitNumber: 1,
        axisLabel: {
          ...textStyle(theme),
          show: scale.limits,
          distance: scale.distance,
          formatter: limit,
        },
        title: { show: false },
        detail: {
          valueAnimation: false,
          offsetCenter: [0, "8%"],
          ...valueText(theme, scale.value),
          formatter: () => text,
        },
        data: [{ value: drawn, name: reading?.label ?? "" }],
      },
    ],
  };
}

/** A bar's row: its label's line and a gap. */
const BAR_ROW_PX = 18;
/** The room a `+N more` note takes under the bars. */
const BAR_NOTE_PX = 18;

/**
 * How many of a bar gauge's readings fit at a size, largest first, and how
 * thick each bar is (#643): every reading while each has its row, else as
 * many as fit with room kept for a `+N more` note, at least one. A bar is
 * 60% of its row, between 4 and 14 pixels.
 */
export function gaugeBarFit(
  size: ChartSize | undefined,
  count: number,
): { shown: number; thickness: number } {
  const budget = labelBudget(size, count, { need: BAR_ROW_PX, chrome: 16 });
  const shown = budget.show
    ? count
    : Math.max(1, Math.floor(((size?.height ?? 0) - 16 - BAR_NOTE_PX) / BAR_ROW_PX));
  const room = budget.show ? budget.room : BAR_ROW_PX;
  return {
    shown: Math.min(count, shown),
    thickness: Math.round(Math.min(14, Math.max(4, room * 0.6))),
  };
}

function bars(
  all: GaugeReading[],
  theme: ChartTheme,
  size: ChartSize | undefined,
): EChartsOption {
  // Largest first already: the ones that do not fit are the smallest.
  const fit = gaugeBarFit(size, all.length);
  const readings = all.slice(0, fit.shown);
  const more = all.length - readings.length;
  return {
    ...shared(theme),
    // Always set, so a note that is no longer needed clears.
    title: {
      text: more > 0 ? `+${more} more` : "",
      right: 0,
      bottom: 0,
      textStyle: { ...textStyle(theme), fontWeight: "normal" },
    },
    grid: {
      left: 8,
      right: 64,
      top: 8,
      bottom: more > 0 ? 8 + BAR_NOTE_PX : 8,
      containLabel: true,
    },
    tooltip: {
      ...tooltip(theme),
      trigger: "item",
      formatter: (p: unknown) => {
        const r = readings[(p as { dataIndex: number }).dataIndex];
        return r ? `${r.label}: ${r.text}` : "";
      },
    },
    // Every bar is its own fraction of its own limits, so rows whose limits
    // come from a column still share one axis.
    xAxis: { type: "value", min: 0, max: 1, show: false },
    yAxis: {
      type: "category",
      inverse: true,
      data: readings.map((r) => r.label),
      // Every row drawn has room for its label (gaugeBarFit), so none is skipped.
      axisLabel: { ...textStyle(theme), interval: 0 },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        type: "bar",
        barMaxWidth: fit.thickness,
        showBackground: true,
        backgroundStyle: { color: theme.track, ...barCorners(theme, true) },
        data: readings.map((r) => ({
          value: r.fraction,
          itemStyle: { color: fillHex(r.color, theme), ...barCorners(theme, true) },
        })),
        label: {
          show: true,
          position: "right",
          ...textStyle(theme),
          formatter: (p: unknown) =>
            readings[(p as { dataIndex: number }).dataIndex]?.text ?? "",
        },
      },
    ],
  };
}

export const gaugeChart: ChartOptionBuilder = normalized(
  (panel, data, { theme, size }) => {
    const readings = gaugeReadings(panel, data);
    return gaugeOptions(panel).variant === "bar"
      ? bars(readings, theme, size)
      : radial(panel, readings[0], theme, size);
  },
);

/** A dial and a bar list are different charts: switching remounts, data never does. */
export function gaugeShape(panel: Panel): string {
  return gaugeOptions(panel).variant ?? "radial";
}
