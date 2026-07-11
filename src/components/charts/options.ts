import type { EChartsOption } from "echarts";
import type { Panel } from "@/lib/ir";
import { chartPalette } from "@/lib/color/oklch";

export interface PanelData {
  columns: string[];
  rows: Record<string, unknown>[];
}

const palette = chartPalette();

function isNumeric(rows: Record<string, unknown>[], key: string): boolean {
  return rows.some((r) => typeof r[key] === "number" || (r[key] !== null && r[key] !== "" && Number.isFinite(Number(r[key]))));
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
  tooltip: { trigger: "axis" },
  legend: { top: 0, textStyle: { color: "#9aa0aa" } },
  backgroundColor: "transparent",
};

/**
 * Build an ECharts option from a panel spec + current (bounded) data. Only
 * line/bar/heatmap/pie/donut map to ECharts; stat/table are rendered as HTML.
 */
export function buildChartOption(panel: Panel, data: PanelData): EChartsOption {
  const x = xKey(panel, data);
  const keys = seriesKeys(panel, data);
  const categories = data.rows.map((r) => String(r[x]));

  if (panel.viz === "heatmap") {
    return buildHeatmap(panel, data);
  }

  if (panel.viz === "pie" || panel.viz === "donut") {
    return buildPie(panel, data);
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
      data: data.rows.map((r) => Number(r[k])),
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
  const valueKey =
    seriesKeys(panel, data)[0] ?? data.columns.find((c) => c !== x) ?? x;
  const radius = panel.viz === "donut" ? ["48%", "72%"] : "72%";
  return {
    color: palette,
    backgroundColor: "transparent",
    tooltip: { trigger: "item" },
    legend: { top: 0, textStyle: { color: "#9aa0aa" } },
    series: [
      {
        type: "pie",
        radius,
        center: ["50%", "56%"],
        data: data.rows.map((r) => ({
          name: String(r[x]),
          value: Number(r[valueKey]) || 0,
        })),
        label: { color: "#9aa0aa" },
        labelLine: { lineStyle: { color: "#3a3f4b" } },
      },
    ],
  };
}

function buildHeatmap(panel: Panel, data: PanelData): EChartsOption {
  const [xk, yk, vk] = data.columns;
  const xs = [...new Set(data.rows.map((r) => String(r[xk])))];
  const ys = [...new Set(data.rows.map((r) => String(r[yk])))];
  const values = data.rows.map((r) => [
    xs.indexOf(String(r[xk])),
    ys.indexOf(String(r[yk])),
    Number(r[vk]) || 0,
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
