import {
  areaChart,
  barChart,
  donutChart,
  heatmapChart,
  lineChart,
  optionsShape,
  pieChart,
  scatterChart,
} from "@/components/charts/options";
import { gaugeChart, gaugeShape } from "@/components/charts/gauge";
import { histogramChart, histogramShape } from "@/components/charts/histogram";
import {
  stateTimelineChart,
  stateTimelineShape,
} from "@/components/charts/state-timeline";
import { StatView } from "@/components/panels/stat";
import { StatusGridView } from "@/components/panels/status-grid";
import { TableView } from "@/components/panels/table";
import { TextView } from "@/components/panels/text";
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
  line: { type: "chart", option: lineChart, shape: optionsShape },
  area: { type: "chart", option: areaChart, shape: optionsShape },
  bar: { type: "chart", option: barChart, shape: optionsShape },
  scatter: { type: "chart", option: scatterChart },
  stat: { type: "html", Body: StatView },
  table: { type: "html", Body: TableView },
  heatmap: { type: "chart", option: heatmapChart },
  pie: { type: "chart", option: pieChart, shape: optionsShape },
  donut: { type: "chart", option: donutChart, shape: optionsShape },
  gauge: { type: "chart", option: gaugeChart, shape: gaugeShape },
  "state-timeline": {
    type: "chart",
    option: stateTimelineChart,
    shape: stateTimelineShape,
  },
  "status-grid": { type: "html", Body: StatusGridView },
  histogram: { type: "chart", option: histogramChart, shape: histogramShape },
  text: { type: "html", Body: TextView },
} as const satisfies Record<VizType, PanelRenderer>;

/** How a kind is drawn. */
export function panelRenderer(viz: VizType): PanelRenderer {
  return PANEL_RENDERERS[viz];
}
