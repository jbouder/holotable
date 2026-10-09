import { definePanelKind } from "@/lib/panels/types";

export const heatmap = definePanelKind({
  kind: "heatmap",
  summary: "Two dimensions against a numeric intensity.",
  promptHint:
    "two dimensions against a numeric intensity; return exactly three columns: x (often a time bucket), y, value.",
  promqlHint:
    "not for a Prometheus source: its rows are a time and one column per series.",
  canvas: true,
  timeBrush: false,
  skeleton: "chart",
  query: "required",
});
