import { definePanelKind } from "@/lib/panels/types";

export const scatter = definePanelKind({
  kind: "scatter",
  summary: "Relationship between two numeric dimensions.",
  promptHint:
    "the relationship between two numeric dimensions; the first numeric column is the x-axis.",
  promqlHint:
    "not for a Prometheus source: its rows are a time and one column per series.",
  canvas: true,
  timeBrush: false,
  skeleton: "scatter",
  query: "required",
});
