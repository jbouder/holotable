import {
  BarChart,
  CustomChart,
  GaugeChart,
  GraphChart,
  HeatmapChart,
  LineChart,
  PieChart,
  SankeyChart,
  ScatterChart,
  SunburstChart,
  TreeChart,
  TreemapChart,
} from "echarts/charts";
import {
  AriaComponent,
  AxisPointerComponent,
  BrushComponent,
  DataZoomInsideComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TitleComponent,
  ToolboxComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { LegacyGridContainLabel } from "echarts/features";
import { init, use } from "echarts/core";
import type { ECharts } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

/**
 * The one module that loads ECharts at runtime (#488).
 *
 * `import * as echarts from "echarts"` shipped every chart type and component
 * the library has. This registers only what the panel renderers draw, on the
 * canvas renderer, and `test/echarts-runtime.test.ts` holds every other file
 * to type imports. A new panel kind that needs a series type or a component
 * adds one line here; nothing else changes.
 *
 * - Series: the chart kinds in `src/components/panels/registry.ts` and their
 *   builders (a donut is a pie; the treemap's sunburst layout; the graph's
 *   tree, and its directed and force graphs as a `graph` series; the Sankey;
 *   the state timeline is a custom series).
 * - Components: the grid and both axes, the tooltip and its axis pointer
 *   (crosshair sync), the legend (plain and scroll), the brush (brush to
 *   zoom), the inside data zoom (a directed graph's pan and zoom), thresholds as a visual map, annotations as mark lines and areas,
 *   the state timeline's "more not shown" title, aria (the chart's
 *   accessible name and decal patterns), and the toolbox, which the brush's
 *   own preprocessor always adds an option for.
 * - Features: `grid.containLabel`, which the state timeline and the bar
 *   gauge use, is opt-in on core.
 *
 * The dark theme is built into core. A missing registration draws nothing
 * in production and warns only in a development build, so a new kind is
 * checked there.
 */
use([
  CanvasRenderer,
  BarChart,
  CustomChart,
  GaugeChart,
  GraphChart,
  HeatmapChart,
  LineChart,
  PieChart,
  SankeyChart,
  ScatterChart,
  SunburstChart,
  TreeChart,
  TreemapChart,
  AriaComponent,
  AxisPointerComponent,
  BrushComponent,
  DataZoomInsideComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TitleComponent,
  ToolboxComponent,
  TooltipComponent,
  VisualMapComponent,
  LegacyGridContainLabel,
]);

export { init };
export type { ECharts };
