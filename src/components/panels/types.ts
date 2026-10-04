import type * as React from "react";
import type { ChartOptionBuilder, PanelData } from "@/components/charts/options";
import type { Panel } from "@/lib/ir";

/**
 * How a panel kind is drawn: the browser half of the panel registry (#61).
 *
 * A kind is either a chart, whose option builder `PanelView` hands to the one
 * long-lived `EChart` (merged on every update, never recreated: invariant 11),
 * or an HTML body. The kind's `canvas` flag in `src/lib/panels/` says the same
 * thing to the code that cannot import React, and a test holds the two to
 * each other.
 */
export type PanelRenderer =
  | { type: "chart"; option: ChartOptionBuilder }
  | { type: "html"; Body: React.ComponentType<PanelBodyProps> };

export interface PanelBodyProps {
  panel: Panel;
  data: PanelData;
}
