import {
  areaChart,
  barChart,
  donutChart,
  heatmapChart,
  lineChart,
  pieChart,
  scatterChart,
} from "@/components/charts/options";
import { StatView } from "@/components/panels/stat";
import { TableView } from "@/components/panels/table";
import type { PanelRenderer } from "@/components/panels/types";
import type { VizType } from "@/lib/ir";

/**
 * Every registered panel kind's renderer, by name (#61).
 *
 * The kinds themselves are listed in `src/lib/panels/registry.ts`; this is
 * where each one is given a way to be drawn. `satisfies Record<VizType, …>`
 * is the point: a kind registered there without a renderer here does not
 * compile, so `PanelView` never meets one it cannot draw.
 */
export const PANEL_RENDERERS = {
  line: { type: "chart", option: lineChart },
  area: { type: "chart", option: areaChart },
  bar: { type: "chart", option: barChart },
  scatter: { type: "chart", option: scatterChart },
  stat: { type: "html", Body: StatView },
  table: { type: "html", Body: TableView },
  heatmap: { type: "chart", option: heatmapChart },
  pie: { type: "chart", option: pieChart },
  donut: { type: "chart", option: donutChart },
} as const satisfies Record<VizType, PanelRenderer>;

/** How a kind is drawn. */
export function panelRenderer(viz: VizType): PanelRenderer {
  return PANEL_RENDERERS[viz];
}
