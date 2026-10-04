import { definePanelKind } from "@/lib/panels/types";

/** One label column against one numeric value column. Not a time series. */

export const pie = definePanelKind({
  kind: "pie",
  summary:
    "Proportional breakdown across a small set of categories. Omits `query.timeField`.",
  promptHint:
    "a proportional breakdown of a small set of categories: one label column and one numeric value column; OMIT 'query.timeField', it is not a time series.",
  canvas: true,
  timeBrush: false,
  skeleton: "radial",
});

export const donut = definePanelKind({
  kind: "donut",
  summary: "A pie with an inner radius. Omits `query.timeField`.",
  promptHint: "the same as 'pie', drawn as a ring.",
  canvas: true,
  timeBrush: false,
  skeleton: "radial",
});
