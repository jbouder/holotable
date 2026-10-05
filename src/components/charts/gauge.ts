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
import type { Panel } from "@/lib/ir";
import { type ColorToken, tokenHex } from "@/lib/panels/colors";
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
  const timeField = panel.query?.timeField;
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
      text: formatValue(value, panel.format),
      color: thresholdColor(options.thresholds, value) ?? DEFAULT_COLOR,
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

/** `#rrggbb` at an opacity, for the faint threshold bands behind the dial. */
function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * The dial's track: the threshold steps as bands, faint, so the value's own
 * color reads as where it is now and the bands as where the lines are.
 */
function bands(panel: Panel, min: number, max: number): [number, string][] {
  const steps = gaugeOptions(panel).thresholds ?? [];
  const track = "#2a2f3a";
  if (steps.length === 0) return [[1, track]];
  const stops: [number, string][] = [];
  let color: string = track;
  for (const step of steps) {
    const at = (step.value - min) / (max - min);
    if (at > 0 && at < 1) stops.push([at, color]);
    if (at < 1) color = withAlpha(tokenHex(step.color), 0.35);
  }
  stops.push([1, color]);
  return stops;
}

function radial(panel: Panel, reading: GaugeReading | undefined): EChartsOption {
  const min = reading?.min ?? DEFAULT_MIN;
  const max = reading?.max ?? DEFAULT_MAX;
  // Clamped for the drawing; the text below says what it really is.
  const drawn = reading ? Math.min(max, Math.max(min, reading.value)) : min;
  const text = reading?.text ?? "—";
  return {
    backgroundColor: "transparent",
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
          width: 14,
          itemStyle: { color: tokenHex(reading?.color ?? DEFAULT_COLOR) },
        },
        axisLine: { lineStyle: { width: 14, color: bands(panel, min, max) } },
        pointer: { show: false },
        anchor: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        splitNumber: 1,
        axisLabel: {
          color: "#9aa0aa",
          distance: 20,
          formatter: (v: number) => formatValue(v, panel.format),
        },
        title: { show: false },
        detail: {
          valueAnimation: false,
          offsetCenter: [0, "8%"],
          fontSize: 24,
          fontWeight: 600,
          color: "#e6e8ee",
          formatter: () => text,
        },
        data: [{ value: drawn, name: reading?.label ?? "" }],
      },
    ],
  };
}

function bars(readings: GaugeReading[]): EChartsOption {
  return {
    backgroundColor: "transparent",
    grid: { left: 8, right: 64, top: 8, bottom: 8, containLabel: true },
    tooltip: {
      trigger: "item",
      borderRadius: 0,
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
      axisLabel: { color: "#9aa0aa" },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        type: "bar",
        barMaxWidth: 18,
        showBackground: true,
        backgroundStyle: { color: "#2a2f3a" },
        data: readings.map((r) => ({
          value: r.fraction,
          itemStyle: { color: tokenHex(r.color) },
        })),
        label: {
          show: true,
          position: "right",
          color: "#9aa0aa",
          formatter: (p: unknown) =>
            readings[(p as { dataIndex: number }).dataIndex]?.text ?? "",
        },
      },
    ],
  };
}

export const gaugeChart: ChartOptionBuilder = normalized((panel, data) => {
  const readings = gaugeReadings(panel, data);
  return gaugeOptions(panel).variant === "bar"
    ? bars(readings)
    : radial(panel, readings[0]);
});

/** A dial and a bar list are different charts: switching remounts, data never does. */
export function gaugeShape(panel: Panel): string {
  return gaugeOptions(panel).variant ?? "radial";
}
