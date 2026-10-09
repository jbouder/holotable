import { z } from "zod";
import { ColorToken } from "@/lib/panels/colors";
import { definePanelKind } from "@/lib/panels/types";

const Column = z.string().min(1).max(128);

export const StateColor = z
  .object({
    state: z.string().min(1).max(64),
    color: ColorToken,
  })
  .strict();

export const StateTimelineOptions = z
  .object({
    /** The lane column; by default the first text column other than the state. */
    entity: Column.optional(),
    /** The state column; by default the last text column. */
    state: Column.optional(),
    /** A color per state, in legend order. Any other state gets a stable fallback. */
    states: z.array(StateColor).max(50).optional(),
    /**
     * `spans` (the default): exact spans. `history`: fixed cells across the
     * window, each showing the state that held at its middle.
     */
    variant: z.enum(["spans", "history"]).optional(),
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
export type StateTimelineOptions = z.infer<typeof StateTimelineOptions>;

/** Discrete states over time, one lane per entity (#201). */
export const stateTimeline = definePanelKind({
  kind: "state-timeline",
  summary:
    "Discrete states over time, one lane per entity: a span runs from a row's time to the next row's for the same entity. Requires `query.timeField`.",
  promptHint:
    "discrete states over time (up/down, deploy phase, job status, circuit-breaker state): return the raw time column (set as 'query.timeField'), an entity column and a state column, ordered by time, without bucketing; name them in options.entity and options.state, and color known states with options.states ([{state, color}]).",
  promqlHint:
    "not for a Prometheus source: it needs an entity column and a state column per row; draw the state value as a 'line' instead.",
  canvas: true,
  timeBrush: false,
  skeleton: "lanes",
  query: "required",
  requiresTimeField: true,
  options: StateTimelineOptions,
});
