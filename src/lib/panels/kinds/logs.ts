import { z } from "zod";
import { StateColor } from "@/lib/panels/kinds/state-timeline";
import { definePanelKind } from "@/lib/panels/types";

const Column = z.string().min(1).max(128);

export const LogsOptions = z
  .object({
    /** The line's text; by default the longest text column. */
    message: Column.optional(),
    /**
     * A level column (`error`, `warn`, …), colored on each line; by default a
     * column named `level` or `severity`.
     */
    level: Column.optional(),
    /**
     * A color per level. Without one, `error` and `fatal` are `danger`,
     * `warn` is `warning`, `info` is `info` and `debug` is `neutral`, in
     * any case.
     */
    levels: z.array(StateColor).max(20).optional(),
    /** Wrap long lines (the default) or cut them at the panel's edge. */
    wrap: z.boolean().optional(),
    /** `newest` first (the default) or `oldest` first. */
    order: z.enum(["newest", "oldest"]).optional(),
    /** Show each line's time (the default). */
    showTime: z.boolean().optional(),
  })
  .strict()
  .superRefine((o, ctx) => {
    const seen = new Set<string>();
    o.levels?.forEach((s, i) => {
      if (seen.has(s.state)) {
        ctx.addIssue({
          code: "custom",
          message: `level "${s.state}" is given a color twice`,
          path: ["levels", i, "state"],
        });
      }
      seen.add(s.state);
    });
  });
export type LogsOptions = z.infer<typeof LogsOptions>;

/** Raw lines, newest first, with a level and the rest of the row behind each (#404). */
export const logs = definePanelKind({
  kind: "logs",
  summary:
    "Log lines: a time, a message and an optional level, newest first, each expandable to the rest of its row. Requires `query.timeField`.",
  promptHint:
    "raw events to read (log lines, audit entries, recent errors): return the raw time column (set as 'query.timeField', no bucketing), a message column and optionally a level column, ORDER BY time DESC LIMIT 200; name them in options.message and options.level. Other columns are shown when a line is expanded.",
  promqlHint:
    "not for a Prometheus source: a PromQL result has no lines to read. Use 'table' for an instant query's series.",
  canvas: false,
  timeBrush: false,
  skeleton: "lines",
  query: "required",
  requiresTimeField: true,
  options: LogsOptions,
});
