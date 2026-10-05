import { definePanelKind } from "@/lib/panels/types";

/** Numeric columns against the time field, one series per column. */

export const line = definePanelKind({
  kind: "line",
  summary: "Time series as a continuous line. Requires `query.timeField`.",
  promptHint:
    "a numeric trend over time; bucket the time column, alias it and set the alias as 'query.timeField'.",
  canvas: true,
  timeBrush: true,
  skeleton: "chart",
  query: "required",
});

export const area = definePanelKind({
  kind: "area",
  summary: "Filled time series. Requires `query.timeField`.",
  promptHint: "a filled time series, for a volume or a total over time.",
  canvas: true,
  timeBrush: true,
  skeleton: "chart",
  query: "required",
});

export const bar = definePanelKind({
  kind: "bar",
  summary: "Bars over time or across a categorical dimension.",
  promptHint: "values per time bucket, or compared across a categorical dimension.",
  canvas: true,
  timeBrush: true,
  skeleton: "chart",
  query: "required",
});
