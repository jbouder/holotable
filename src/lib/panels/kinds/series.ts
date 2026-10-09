import { SeriesOptions } from "@/lib/panels/presentation";
import { definePanelKind } from "@/lib/panels/types";

/** Numeric columns against the time field, one series per column. */

const SERIES_GROUPS = ["number", "axis", "legend", "thresholds"] as const;

export const line = definePanelKind({
  kind: "line",
  summary: "Time series as a continuous line. Requires `query.timeField`.",
  promptHint:
    "a numeric trend over time; bucket the time column, alias it and set the alias as 'query.timeField'.",
  promqlHint:
    "a range query (no 'instant'); each series is a line, so aggregate to a few: sum by (route) (rate(http_requests_total[5m])).",
  canvas: true,
  timeBrush: true,
  skeleton: "chart",
  query: "required",
  options: SeriesOptions,
  optionGroups: SERIES_GROUPS,
});

export const area = definePanelKind({
  kind: "area",
  summary: "Filled time series. Requires `query.timeField`.",
  promptHint: "a filled time series, for a volume or a total over time.",
  promqlHint: "a range query drawn filled, for a volume or a total over time.",
  canvas: true,
  timeBrush: true,
  skeleton: "chart",
  query: "required",
  options: SeriesOptions,
  optionGroups: SERIES_GROUPS,
});

export const bar = definePanelKind({
  kind: "bar",
  summary: "Bars over time or across a categorical dimension.",
  promptHint: "values per time bucket, or compared across a categorical dimension.",
  promqlHint:
    "a range query drawn as bars per step, or an instant query ('instant': true) compared across one label: sum by (status) (increase(http_requests_total[1h])).",
  canvas: true,
  timeBrush: true,
  skeleton: "chart",
  query: "required",
  options: SeriesOptions,
  optionGroups: SERIES_GROUPS,
});
