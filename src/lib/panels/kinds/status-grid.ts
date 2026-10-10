import { z } from "zod";
import { StateColor } from "@/lib/panels/kinds/state-timeline";
import { NumberFields } from "@/lib/panels/presentation";
import { Thresholds } from "@/lib/panels/thresholds";
import { definePanelKind } from "@/lib/panels/types";

const Column = z.string().min(1).max(128);

export const StatusGridOptions = z
  .object({
    /** The tile's label; by default the first text column other than the state. */
    entity: Column.optional(),
    /** The number on the tile; by default the first numeric column. */
    value: Column.optional(),
    /**
     * A discrete state column. When named, it colors the tile through
     * `states` and is written on it; otherwise the value's threshold does.
     */
    state: Column.optional(),
    /** A color per state. Any other state gets a stable fallback. */
    states: z.array(StateColor).max(50).optional(),
    /**
     * Tile order: `label` (the default, so a tile stays where it was),
     * `value` (largest first) or `none` (the result's order).
     */
    sort: z.enum(["label", "value", "none"]).optional(),
    /** A fixed number of tiles per row; by default as many as fit. */
    columns: z.number().int().min(1).max(12).optional(),
    thresholds: Thresholds.optional(),
    ...NumberFields,
  })
  .strict()
  .superRefine((o, ctx) => {
    const seen = new Set<string>();
    o.states?.forEach((s, i) => {
      if (seen.has(s.state)) {
        ctx.addIssue({
          code: "custom",
          message: `state "${s.state}" is given a color twice`,
          path: ["states", i, "state"],
        });
      }
      seen.add(s.state);
    });
  });
export type StatusGridOptions = z.infer<typeof StatusGridOptions>;

/** One tile per entity, colored by threshold or by state (#404). */
export const statusGrid = definePanelKind({
  kind: "status-grid",
  summary:
    "One tile per entity (a host, a service), showing its latest value and colored by `options.thresholds` or, with `options.state`, by a discrete state.",
  promptHint:
    "which of many things is healthy at a glance (hosts, services, pods): one row per entity, or a series per entity of which the latest row is shown; name the label column in options.entity and the number in options.value, color it with options.thresholds ([{value, color}] ascending), or name a state column in options.state and color it with options.states ([{state, color}]). Use 'gauge' bar for a ranked comparison against a limit.",
  promqlHint:
    "an instant query ('instant': true), one tile per series, e.g. 'up' or 'max by (instance) (…)'; name the label in options.entity (e.g. instance) and color the value with options.thresholds.",
  canvas: false,
  timeBrush: false,
  skeleton: "grid",
  query: "required",
  options: StatusGridOptions,
  optionGroups: ["number", "thresholds"],
});
