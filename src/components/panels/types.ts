import type * as React from "react";
import type { EChartHandle } from "@/components/charts/EChart";
import type { ChartOptionBuilder, PanelData } from "@/components/charts/options";
import type { Panel } from "@/lib/ir";

/**
 * How a panel kind is drawn: the browser half of the panel registry (#61).
 *
 * A kind is a chart, whose option builder `PanelView` hands to the one
 * long-lived `EChart` (merged on every update, never recreated: invariant 11);
 * an HTML body; or a view, a body that draws its own image (a custom visual,
 * #405) and is handed the same export handle a chart is. The kind's `canvas`
 * flag in `src/lib/panels/` says "an ECharts chart" to the code that cannot
 * import React, its `image` flag says "a view", and a test holds them to the
 * renderers.
 */
export type PanelRenderer =
  | {
      type: "chart";
      option: ChartOptionBuilder;
      /**
       * Which of the kind's chart layouts this panel is (a gauge's dial or
       * bars). A change of shape remounts the chart, because a merged
       * `setOption` cannot take back the axes of the old one; data updates
       * never change it, so they still merge (invariant 11).
       */
      shape?: (panel: Panel) => string;
    }
  | { type: "html"; Body: React.ComponentType<PanelBodyProps> }
  | { type: "view"; Body: React.ComponentType<PanelViewProps> };

export interface PanelBodyProps {
  panel: Panel;
  data: PanelData;
}

export interface PanelViewProps extends PanelBodyProps {
  /** What the PNG export calls: the view's own image of itself. */
  handle?: React.Ref<EChartHandle>;
}
