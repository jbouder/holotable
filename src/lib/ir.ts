import { z } from "zod";

/**
 * Shared Intermediate Representation (IR).
 *
 * This is the SINGLE Zod schema shared between the LLM output, the API layer,
 * persistence and the client. The LLM emits a validated spec that conforms to
 * this schema; it never emits data. Everything (generate, save, render) parses
 * against these schemas so the contract cannot drift.
 */

export const VizType = z.enum([
  "line",
  "area",
  "bar",
  "scatter",
  "stat",
  "table",
  "heatmap",
  "pie",
  "donut",
]);
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

/**
 * The IR version this build writes, and the only one {@link Dashboard}
 * accepts.
 *
 * A saved spec is the one piece of state that cannot be regenerated, so a
 * breaking change to the shapes above does not get to strand the ones already
 * stored. It bumps this number instead, and adds the upgrader that carries a
 * spec of the previous version forward to `src/lib/ir/upgrade.ts`. Everything
 * that reads a spec it did not just build — a stored version row, a template,
 * an export file, a draft, a request from a tab opened before the deploy —
 * reads it through `StoredDashboard` there, which applies the chain in memory
 * and then validates against this schema.
 */
export const SPEC_VERSION = 1;

const DashboardFields = {
  title: z.string().min(1).max(200),
  timeRange: TimeRange,
  refreshIntervalMs: z.number().int().min(1_000).max(3_600_000),
  panels: z.array(Panel).min(1).max(50),
};

function uniquePanelIds(dash: { panels: Panel[] }, ctx: z.RefinementCtx): void {
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
}

export const Dashboard = z
  .object({
    specVersion: z.literal(SPEC_VERSION, {
      error: `specVersion must be ${SPEC_VERSION}; an older spec is read through StoredDashboard, which upgrades it`,
    }),
    ...DashboardFields,
  })
  .strict()
  .superRefine(uniquePanelIds);
export type Dashboard = z.infer<typeof Dashboard>;

/**
 * The schema the LLM is asked to produce: the Dashboard IR minus
 * `specVersion`. The model authors a validated viz spec, never data rows, and
 * never the version — which shape a spec is in is a fact about this build, not
 * something a model gets to assert. `.strict()` means a model that offers one
 * anyway is refused, and {@link fromGenerated} stamps the current version on
 * what it did produce.
 */
export const DashboardGenerationSchema = z
  .object(DashboardFields)
  .strict()
  .superRefine(uniquePanelIds);
export type GeneratedDashboard = z.infer<typeof DashboardGenerationSchema>;

/**
 * A generated dashboard as a spec of this build's version. Only for output of
 * {@link DashboardGenerationSchema}, which was produced against exactly these
 * shapes; anything older goes through `StoredDashboard`.
 */
export function fromGenerated(generated: GeneratedDashboard): Dashboard {
  return { specVersion: SPEC_VERSION, ...generated };
}

/** A spec as the model is shown it, when it is asked to change one. */
export function forGeneration(spec: Dashboard): GeneratedDashboard {
  const { specVersion: _, ...rest } = spec;
  return rest;
}

export function parseDashboard(input: unknown): Dashboard {
  return Dashboard.parse(input);
}

export function safeParseDashboard(input: unknown) {
  return Dashboard.safeParse(input);
}
