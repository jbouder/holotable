import type { EChartsOption } from "echarts";
import type { Panel } from "@/lib/ir";
import { chartPalette } from "@/lib/color/oklch";

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

const BASE: EChartsOption = {
  color: palette,
  grid: { left: 44, right: 16, top: 24, bottom: 28 },
  tooltip: { trigger: "axis", borderRadius: 0 },
  legend: { top: 0, textStyle: { color: "#9aa0aa" } },
  backgroundColor: "transparent",
};

/**
 * Build an ECharts option from a panel spec + current (bounded) data. Only
 * line/area/bar/scatter/heatmap/pie/donut map to ECharts; stat/table are rendered as HTML.
 */
export function buildChartOption(panel: Panel, raw: PanelData): EChartsOption {
  const data = normalize(raw);
  const x = xKey(panel, data);
  const keys = seriesKeys(panel, data);
  const categories = data.rows.map((r) => toText(r[x]));

  if (panel.viz === "heatmap") {
    return buildHeatmap(panel, data);
  }

  if (panel.viz === "pie" || panel.viz === "donut") {
    return buildPie(panel, data);
  }

  if (panel.viz === "scatter") {
    return buildScatter(data);
  }

  const type = panel.viz === "bar" ? "bar" : "line";
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
      areaStyle: panel.viz === "area" ? {} : undefined,
      data: data.rows.map((r) => toNumber(r[k])),
    })),
  };
}

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
function buildPie(panel: Panel, data: PanelData): EChartsOption {
  const x = xKey(panel, data);
  const valueKey = seriesKeys(panel, data)[0] ?? data.columns.find((c) => c !== x) ?? x;
  const radius = panel.viz === "donut" ? ["48%", "72%"] : "72%";
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

function buildHeatmap(_panel: Panel, data: PanelData): EChartsOption {
  const [xk, yk, vk] = data.columns;
  const xs = [...new Set(data.rows.map((r) => toText(r[xk])))];
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
    xAxis: { type: "category", data: xs, axisLabel: { color: "#9aa0aa" } },
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
