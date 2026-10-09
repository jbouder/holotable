import { StatOptions } from "@/lib/panels/presentation";
import { definePanelKind } from "@/lib/panels/types";

export const stat = definePanelKind({
  kind: "stat",
  summary:
    "A single scalar value, formatted per `panel.format`. Omits `query.timeField`.",
  promptHint: "a single scalar value; OMIT 'query.timeField'.",
  promqlHint:
    "an instant query ('instant': true) returning one series: sum(rate(http_requests_total[5m])).",
  canvas: false,
  timeBrush: false,
  skeleton: "stat",
  query: "required",
  options: StatOptions,
  optionGroups: ["stat", "number", "thresholds"],
});
