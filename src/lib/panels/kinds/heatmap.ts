import { definePanelKind } from "@/lib/panels/types";

export const heatmap = definePanelKind({
  kind: "heatmap",
  summary: "Two dimensions against a numeric intensity.",
  promptHint:
    "two dimensions against a numeric intensity; return exactly three columns: x (often a time bucket), y, value.",
  canvas: true,
  timeBrush: false,
  skeleton: "chart",
});
