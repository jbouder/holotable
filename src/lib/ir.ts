import { z } from "zod";
import { DashboardAnnotations } from "@/lib/annotations";
import { ValueFormat } from "@/lib/panels/presentation";
import { findPanelKind, PANEL_KIND_NAMES, PANEL_KINDS } from "@/lib/panels/registry";

/**
 * Shared Intermediate Representation (IR).
 *
 * This is the SINGLE Zod schema shared between the LLM output, the API layer,
 * persistence and the client. The LLM emits a validated spec that conforms to
 * this schema; it never emits data. Everything (generate, save, render) parses
 * against these schemas so the contract cannot drift.
 */

/**
 * The panel kinds, as registered in `src/lib/panels/registry.ts` (#61). The
 * list lives there, with each kind's prompt hint and capabilities, so adding a
 * kind is not an edit to this file.
 */
export const VizType = z.enum(PANEL_KIND_NAMES, {
  error: (issue) =>
    typeof issue.input === "string"
      ? `unknown panel kind ${JSON.stringify(issue.input.slice(0, 64))}; viz must be one of: ${PANEL_KIND_NAMES.join(", ")}`
      : undefined,
});
export type VizType = z.infer<typeof VizType>;

export { ValueFormat };

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

/** How often a dashboard, or a panel with its own cadence, is re-run. */
export const RefreshIntervalMs = z.number().int().min(1_000).max(3_600_000);

export const PanelLayout = z
  .object({
    x: z.number().int().min(0).max(12),
    y: z.number().int().min(0).max(1000),
    w: z.number().int().min(1).max(12),
    h: z.number().int().min(1).max(48),
  })
  .strict();
export type PanelLayout = z.infer<typeof PanelLayout>;

/**
 * A panel's presentation options (#61): one of the registered kinds' option
 * schemas. Which one is the kind's, and `Panel` holds it to that below; the
 * union is what tells the model the shapes there are.
 *
 * A malformed object fails every branch, so the message is taken from the
 * branch it came closest to rather than a bare "Invalid input": the one whose
 * fields it uses, with the fewest issues among those. Kinds share field names
 * (`thresholds`, `legend`), so a count alone would often pick another kind.
 */
const optionSchemas = PANEL_KINDS.flatMap((k) => (k.options ? [k.options] : []));
export const PanelOptions = z.union(
  optionSchemas as [(typeof optionSchemas)[number], ...(typeof optionSchemas)[number][]],
  {
    error: (issue) => {
      if (issue.code !== "invalid_union" || !("errors" in issue)) return undefined;
      const unknownKeys = (errors: { code: string }[]) =>
        errors.filter((e) => e.code === "unrecognized_keys").length;
      const closest = [...issue.errors].sort(
        (a, b) => unknownKeys(a) - unknownKeys(b) || a.length - b.length,
      )[0]?.[0];
      if (!closest) return undefined;
      const at = closest.path.length > 0 ? `${closest.path.join(".")}: ` : "";
      return `invalid options: ${at}${closest.message}`;
    },
  },
);

/**
 * What a panel's kind asks of the rest of it: a query or none (a text panel,
 * #202), a time field (a state timeline, #201), and options that are its own.
 */
function fitsItsKind(panel: z.infer<typeof PanelFields>, ctx: z.RefinementCtx): void {
  const kind = findPanelKind(panel.viz);
  if (!kind) return;
  if (kind.query === "none" && panel.query !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: `a ${kind.kind} panel runs no query; remove "query"`,
      path: ["query"],
    });
  }
  if (kind.query === "required" && panel.query === undefined) {
    ctx.addIssue({
      code: "custom",
      message: `a ${kind.kind} panel needs a "query"`,
      path: ["query"],
    });
  }
  if (kind.requiresTimeField && panel.query && panel.query.timeField === undefined) {
    ctx.addIssue({
      code: "custom",
      message: `a ${kind.kind} panel needs "query.timeField"`,
      path: ["query", "timeField"],
    });
  }
  if (kind.query === "none") {
    // Nothing runs, so there is no window to own and nothing to refresh.
    for (const key of ["timeRange", "refreshIntervalMs"] as const) {
      if (panel[key] !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: `a ${kind.kind} panel runs no query; remove "${key}"`,
          path: [key],
        });
      }
    }
  }
  if (!kind.options) {
    if (panel.options !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `a ${kind.kind} panel takes no options`,
        path: ["options"],
      });
    }
    return;
  }
  const own = kind.options.safeParse(panel.options ?? {});
  for (const issue of own.success ? [] : own.error.issues) {
    ctx.addIssue({
      code: "custom",
      message: issue.message,
      path: ["options", ...issue.path],
    });
  }
}

const PanelFields = z
  .object({
    id: z.string().min(1).max(64),
    title: z.string().min(1).max(200),
    /**
     * Optional human-readable summary of WHAT this panel computes (intent, not
     * data values). Populated for ad-hoc exploration; safe to omit elsewhere.
     */
    description: z.string().max(500).optional(),
    viz: VizType,
    /**
     * Absent exactly when the kind runs no query (a text panel, #202). Code
     * that executes, validates or lists queries goes through `hasQuery`.
     */
    query: PanelQuery.optional(),
    /** The kind's own options, validated against its schema. */
    options: PanelOptions.optional(),
    format: ValueFormat.optional(),
    /**
     * The panel's own window, in place of the dashboard's and of the one a
     * viewer picked (#114). Resolved by the server like any other.
     */
    timeRange: TimeRange.optional(),
    /** The panel's own cadence, under the same bounds and floor as the dashboard's. */
    refreshIntervalMs: RefreshIntervalMs.optional(),
    layout: PanelLayout,
  })
  .strict();

export const Panel = PanelFields.superRefine(fitsItsKind);
export type Panel = z.infer<typeof Panel>;

/*
 * The panel the MODEL is asked for (#335). `Panel` keeps `query` optional,
 * because a text panel (#202) has none, and says which kinds need one in a
 * refinement — which JSON Schema cannot express, so a model reading the schema
 * it is bound to saw `query` as optional and could leave it out of every panel.
 * Here the two shapes are spelled out instead: a kind that runs a query has
 * `query` required, and a query-less kind has no `query` (nor the window and
 * cadence it would govern). Both are still held to `fitsItsKind`, and both are
 * `Panel`s, so nothing downstream of generation changes.
 */
const kindsWhere = (query: "required" | "none") =>
  PANEL_KINDS.filter((k) => k.query === query).map((k) => k.kind) as [
    VizType,
    ...VizType[],
  ];

/** A generated panel of a kind that runs a query: `query` is required. */
const GeneratedQueryPanel = PanelFields.extend({
  viz: z.enum(kindsWhere("required")),
  query: PanelQuery,
});

/** A generated panel of a kind that runs no query: it has no `query`. */
const GeneratedQuerylessPanel = PanelFields.omit({
  query: true,
  timeRange: true,
  refreshIntervalMs: true,
}).extend({ viz: z.enum(kindsWhere("none")) });

/**
 * What generation asks the model for when a panel may be of any kind. Typed as
 * `Panel`, which both shapes are: the union is for the schema the model reads,
 * and code downstream keeps reading `panel.query` through `hasQuery` as before.
 */
export const GeneratedPanel: z.ZodType<Panel> = z
  .discriminatedUnion("viz", [GeneratedQueryPanel, GeneratedQuerylessPanel])
  .superRefine(fitsItsKind);

/**
 * A panel that answers a question from data: what explore asks the model for.
 * A text panel (#202) is a valid panel but no answer, so its kind is not
 * offered at all.
 */
export const ExplorePanel = GeneratedQueryPanel.superRefine(fitsItsKind);

/** A panel that runs a query: every kind but the query-less ones. */
export type QueryPanel = Panel & { query: PanelQuery };

/**
 * Whether a panel runs a query. Everything that executes, validates, lists or
 * re-points queries filters through this, and skips the rest (#202).
 */
export function hasQuery(panel: Panel): panel is QueryPanel {
  return panel.query !== undefined;
}

/**
 * The window a panel is run over: its own (#114), or else the one it is shown
 * in, which is the dashboard's or the one a viewer picked. The server resolves
 * whichever it is; this only says which.
 */
export function panelTimeRange(panel: Panel, shown: TimeRange): TimeRange {
  return panel.timeRange ?? shown;
}

/**
 * How often a panel is re-run: its own cadence (#114), or the dashboard's.
 * The server still holds either to `MIN_REFRESH_INTERVAL_MS`.
 */
export function panelRefreshMs(panel: Panel, dashboardMs: number): number {
  return panel.refreshIntervalMs ?? dashboardMs;
}

/**
 * The longest a live dashboard goes between completed cycles: its fastest
 * panel's cadence. Panels without their own run at the dashboard's, so this is
 * the dashboard's own unless every panel that runs a query is slower.
 */
export function cycleMs(spec: Pick<Dashboard, "panels" | "refreshIntervalMs">): number {
  const cadences = spec.panels
    .filter(hasQuery)
    .map((p) => panelRefreshMs(p, spec.refreshIntervalMs));
  return cadences.length > 0 ? Math.min(...cadences) : spec.refreshIntervalMs;
}

/**
 * Dashboard variables (#67): a name panel SQL references as `:name`, and the
 * values a viewer may pick for it. A value is only ever a bound parameter
 * (`src/lib/sql/variables.ts`), and the server checks every value it is sent
 * against this declaration: the listed `values` of an `enum`, or what the
 * variable's own guarded `query` returns.
 */
export const VariableName = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{0,31}$/,
    "a variable name is lowercase letters, digits and _, starting with a letter, at most 32",
  );

/** One value, as a viewer selects it and the statement is bound with it. */
export const VariableText = z.string().min(1).max(256);

/** The most values a variable lists, or its query offers. */
export const VARIABLE_VALUES_MAX = 200;

/**
 * Where a `query` variable's values come from: the first column of a guarded
 * SELECT against a source in the dashboard's workspace. No time filter, and
 * no variables of its own.
 */
export const VariableQuery = z
  .object({
    sourceId: z.string().min(1).max(128),
    sql: z.string().min(1).max(8_000),
  })
  .strict();

export const Variable = z
  .object({
    name: VariableName,
    /** What the picker is labeled; the name by default. */
    label: z.string().min(1).max(64).optional(),
    type: z.enum(["enum", "query"]),
    /** An `enum`'s values, in the picker's order. */
    values: z.array(VariableText).min(1).max(VARIABLE_VALUES_MAX).optional(),
    /** A `query` variable's source of values. */
    query: VariableQuery.optional(),
    /** Several values at once, bound as an array: write `col = ANY(:name)`. */
    multi: z.boolean().optional(),
    /** The selection before a viewer picks one. By default the first value. */
    default: z
      .union([VariableText, z.array(VariableText).min(1).max(VARIABLE_VALUES_MAX)])
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.type === "enum" && (v.values === undefined || v.query !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message: 'an "enum" variable lists "values" and has no "query"',
        path: ["values"],
      });
    }
    if (v.type === "query" && (v.query === undefined || v.values !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message: 'a "query" variable has a "query" and no "values"',
        path: ["query"],
      });
    }
    if (v.values && new Set(v.values).size !== v.values.length) {
      ctx.addIssue({
        code: "custom",
        message: "values must be unique",
        path: ["values"],
      });
    }
    if (Array.isArray(v.default) && !v.multi) {
      ctx.addIssue({
        code: "custom",
        message: 'only a "multi" variable defaults to several values',
        path: ["default"],
      });
    }
    const defaults = v.default === undefined ? [] : [v.default].flat();
    if (v.values && defaults.some((d) => !v.values?.includes(d))) {
      ctx.addIssue({
        code: "custom",
        message: "the default must be one of the values",
        path: ["default"],
      });
    }
  });
export type Variable = z.infer<typeof Variable>;

/** The names a dashboard declares: what its panels' SQL may reference. */
export function declaredVariables(spec: { variables?: Variable[] }): Set<string> {
  return new Set((spec.variables ?? []).map((v) => v.name));
}

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
  refreshIntervalMs: RefreshIntervalMs,
  panels: z.array(Panel).min(1).max(50),
  /** Variables panel SQL may reference as `:name` (#67). */
  variables: z.array(Variable).max(10).optional(),
  /** Whether, and which, annotations are drawn on its time-series panels (#68). */
  annotations: DashboardAnnotations.optional(),
};

function uniqueIds(
  dash: { panels: Panel[]; variables?: Variable[] },
  ctx: z.RefinementCtx,
): void {
  const names = new Set<string>();
  dash.variables?.forEach((v, i) => {
    if (names.has(v.name)) {
      ctx.addIssue({
        code: "custom",
        message: `duplicate variable "${v.name}"`,
        path: ["variables", i, "name"],
      });
    }
    names.add(v.name);
  });
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
  .superRefine(uniqueIds);
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
  .object({
    ...DashboardFields,
    // Spelled out for the model; every one of these is a `Panel` (#335).
    panels: z.array(GeneratedPanel).min(1).max(50),
  })
  .strict()
  .superRefine(uniqueIds);
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
