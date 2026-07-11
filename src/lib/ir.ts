import { z } from "zod";

/**
 * Shared Intermediate Representation (IR).
 *
 * This is the SINGLE Zod schema shared between the LLM output, the API layer,
 * persistence and the client. The LLM emits a validated spec that conforms to
 * this schema; it never emits data. Everything (generate, save, render) parses
 * against these schemas so the contract cannot drift.
 */

export const VizType = z.enum(["line", "bar", "stat", "table", "heatmap"]);
export type VizType = z.infer<typeof VizType>;

export const ValueFormat = z.enum(["number", "bytes", "percent", "ms"]);
export type ValueFormat = z.infer<typeof ValueFormat>;

/**
 * Relative or absolute time expression. Relative forms: `now`, `now-15m`,
 * `now-1h`, `now-24h`, `now-7d`. Absolute form: ISO-8601 timestamp.
 */
export const TimeExpr = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^(now(-\d+[smhdw])?|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?)$/,
    "must be a relative (now, now-15m) or ISO-8601 absolute time",
  );

export const TimeRange = z
  .object({
    from: TimeExpr,
    to: TimeExpr,
  })
  .strict();
export type TimeRange = z.infer<typeof TimeRange>;

/**
 * A panel query. `sourceId` is a stable, opaque reference into the source
 * registry. The panel NEVER carries connection details or credentials — only
 * this id. `sql` is untrusted and validated/guarded before execution. There is
 * intentionally no model-provided time filter: the server injects the
 * dashboard time range at execution time via `timeField`.
 */
export const PanelQuery = z
  .object({
    sourceId: z.string().min(1).max(128),
    sql: z.string().min(1).max(8_000),
    /** Column used by the server to inject the dashboard time-range filter. */
    timeField: z.string().min(1).max(128).optional(),
  })
  .strict();
export type PanelQuery = z.infer<typeof PanelQuery>;

export const PanelLayout = z
  .object({
    x: z.number().int().min(0).max(12),
    y: z.number().int().min(0).max(1000),
    w: z.number().int().min(1).max(12),
    h: z.number().int().min(1).max(48),
  })
  .strict();
export type PanelLayout = z.infer<typeof PanelLayout>;

export const Panel = z
  .object({
    id: z.string().min(1).max(64),
    title: z.string().min(1).max(200),
    /**
     * Optional human-readable summary of WHAT this panel computes (intent, not
     * data values). Populated for ad-hoc exploration; safe to omit elsewhere.
     */
    description: z.string().max(500).optional(),
    viz: VizType,
    query: PanelQuery,
    format: ValueFormat.optional(),
    layout: PanelLayout,
  })
  .strict();
export type Panel = z.infer<typeof Panel>;

export const Dashboard = z
  .object({
    title: z.string().min(1).max(200),
    timeRange: TimeRange,
    refreshIntervalMs: z.number().int().min(1_000).max(3_600_000),
    panels: z.array(Panel).min(1).max(50),
  })
  .strict()
  .superRefine((dash, ctx) => {
    const ids = new Set<string>();
    dash.panels.forEach((p, i) => {
      if (ids.has(p.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate panel id "${p.id}"`,
          path: ["panels", i, "id"],
        });
      }
      ids.add(p.id);
    });
  });
export type Dashboard = z.infer<typeof Dashboard>;

/**
 * The schema the LLM is asked to produce. It is exactly the Dashboard IR: the
 * model authors a validated viz spec, never data rows.
 */
export const DashboardGenerationSchema = Dashboard;

export function parseDashboard(input: unknown): Dashboard {
  return Dashboard.parse(input);
}

export function safeParseDashboard(input: unknown) {
  return Dashboard.safeParse(input);
}
