import { z } from "zod";
import { DashboardAnnotations } from "@/lib/annotations";
import { Column, ValueFormat } from "@/lib/panels/presentation";
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
 * A length of time, for the places a query may name one (`15s`, `1m`, `6h`).
 * Kept beside `TimeExpr` because it is the other half of how the IR talks
 * about time: a duration says how long, never when.
 */
export const Duration = z
  .string()
  .max(16)
  .regex(/^\d+(ms|s|m|h|d)$/, "must be a duration such as 15s, 1m or 6h");
export type Duration = z.infer<typeof Duration>;

/**
 * A SQL panel query. `sourceId` is a stable, opaque reference into the source
 * registry. The panel NEVER carries connection details or credentials — only
 * this id. `sql` is untrusted and validated/guarded before execution. There is
 * intentionally no model-provided time filter: the server injects the
 * dashboard time range at execution time via `timeField`.
 */
export const SqlQuery = z
  .object({
    sourceId: z.string().min(1).max(128),
    sql: z.string().min(1).max(8_000),
    /** Column used by the server to inject the dashboard time-range filter. */
    timeField: z.string().min(1).max(128).optional(),
  })
  .strict();
export type SqlQuery = z.infer<typeof SqlQuery>;

/**
 * A PromQL panel query (#383), against a Prometheus-compatible source. Like
 * SQL it is untrusted, and is validated and rewritten by the guard before it
 * runs. It carries no time: the server picks `start`, `end` and `step` for
 * the window it resolved, and a range query's rows always carry a `time`
 * column.
 */
export const PromqlQuery = z
  .object({
    sourceId: z.string().min(1).max(128),
    /** The PromQL expression. Untrusted; validated and rewritten by the guard before execution. */
    promql: z.string().min(1).max(8_000),
    /**
     * One sample per series at the end of the window (`/api/v1/query`)
     * instead of a range. For stat, gauge, pie and table panels.
     */
    instant: z.boolean().optional(),
    /** A floor on the step. The server picks the step; this only raises it. */
    minStep: Duration.optional(),
  })
  .strict();
export type PromqlQuery = z.infer<typeof PromqlQuery>;

/**
 * A panel query: SQL or PromQL, decided by which of `sql` and `promql` it
 * carries. Both branches are strict and each has a field the other lacks, so
 * every spec stored before PromQL existed parses through `SqlQuery` exactly
 * as it did, and a query carrying both is refused. Which language a panel may
 * use is its source's kind's to say (ADR 2), and is checked where it runs.
 *
 * Code reads a query through the helpers below (`isSqlQuery`,
 * `queryLanguage`, `queryTimeField`, `queryText`), never its fields, outside
 * the SQL-specific modules; `test/query-language.test.ts` holds that.
 */
export const PanelQuery = z.union([SqlQuery, PromqlQuery]);
export type PanelQuery = z.infer<typeof PanelQuery>;

/** The language a query is written in. */
export type QueryLanguage = "sql" | "promql";

export function isSqlQuery<Q extends { sourceId: string }>(
  query: Q,
): query is Extract<Q, { sql: string }> {
  return "sql" in query && typeof query.sql === "string";
}

export function isPromqlQuery<Q extends { sourceId: string }>(
  query: Q,
): query is Extract<Q, { promql: string }> {
  return "promql" in query && typeof query.promql === "string";
}

export function queryLanguage(query: PanelQuery): QueryLanguage {
  return isSqlQuery(query) ? "sql" : "promql";
}

/**
 * The output column the server filters time on and a chart draws time from:
 * the declared `timeField` of a SQL query; `time` for a PromQL range query,
 * whose rows always carry it; nothing for an instant query, which has one
 * sample per series and no axis.
 */
export function queryTimeField(query: PanelQuery): string | undefined {
  if (isSqlQuery(query)) return query.timeField;
  return query.instant ? undefined : PROMQL_TIME_FIELD;
}

/** The column a PromQL range query's rows carry their time in. */
export const PROMQL_TIME_FIELD = "time";

/**
 * The statement, for the places that only display, digest or diff it. Never
 * for running it: execution goes through the source's kind, which knows what
 * language it is.
 */
export function queryText(query: PanelQuery | VariableQuery): string {
  if (isSqlQuery(query)) return query.sql;
  if (isPromqlQuery(query)) return query.promql;
  return query.match
    ? `label_values(${query.match}, ${query.label})`
    : `label_values(${query.label})`;
}

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

/**
 * Where a link's pick for one variable comes from (#371): a literal, the
 * clicked row's value in a result column, or the clicked series' name (the
 * pivot value on a line, area or bar; the slice on a pie), or one label out of
 * the clicked PromQL series' name (`metric{host="a"}` → `a`, #388). Whatever
 * it reads, the target checks the value against its own variable on arrival,
 * exactly as it checks a hand-typed `var-*` pick.
 */
export const LinkValue = z.union([
  z.object({ value: VariableText }).strict(),
  z.object({ column: Column }).strict(),
  z.object({ series: z.literal(true) }).strict(),
  z
    .object({
      label: z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, "must be a Prometheus label name"),
    })
    .strict(),
]);
export type LinkValue = z.infer<typeof LinkValue>;

/** The most links one panel declares, and the most variables one link sets. */
export const PANEL_LINKS_MAX = 5;
export const LINK_SET_MAX = 10;

/**
 * Where a panel leads (#370, #371): another dashboard in the same workspace,
 * or, with no `dashboard`, this one ("click to filter"). The target is an
 * opaque dashboard id, like `sourceId`, and never a URL: there is nothing here
 * a model could point outside the app. A link carries time expressions and
 * variable picks, never SQL; which values a viewer may bind stays the target's
 * decision when the viewer arrives, and the server still owns time.
 */
export const PanelLink = z
  .object({
    /** What the menu item or the click says. */
    title: z.string().min(1).max(64),
    /** The target dashboard's id. Absent: this dashboard. */
    dashboard: z.string().min(1).max(128).optional(),
    /**
     * Whether the viewer's current window and variable picks go along. Each is
     * `true` when absent; read them through `linkCarries`.
     */
    carry: z
      .object({
        timeRange: z.boolean().optional(),
        variables: z.boolean().optional(),
      })
      .strict()
      .optional(),
    /** Picks to make on arrival, by variable name. */
    set: z
      .record(VariableName, LinkValue)
      .refine((set) => Object.keys(set).length <= LINK_SET_MAX, {
        message: `a link sets at most ${LINK_SET_MAX} variables`,
      })
      .optional(),
    /** Open in a new tab rather than this one. */
    newTab: z.boolean().optional(),
  })
  .strict();
export type PanelLink = z.infer<typeof PanelLink>;

/**
 * Whether a link reads the datum that was clicked: any pick from a `column`,
 * the `series` or one of its `label`s. It is followed by clicking a point, slice, cell or row; a
 * link with only literals (or no `set`) is a panel link, followed from the
 * panel's menu.
 */
export function isDatumLink(link: PanelLink): boolean {
  return Object.values(link.set ?? {}).some((v) => !("value" in v));
}

/** Whether a link stays on this dashboard and sets its variables in place. */
export function isSelfLink(link: PanelLink): boolean {
  return link.dashboard === undefined;
}

/** What a link carries along, with the defaults applied. */
export function linkCarries(link: PanelLink): { timeRange: boolean; variables: boolean } {
  return {
    timeRange: link.carry?.timeRange ?? true,
    variables: link.carry?.variables ?? true,
  };
}

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
  if (
    kind.requiresTimeField &&
    panel.query &&
    queryTimeField(panel.query) === undefined
  ) {
    const sql = isSqlQuery(panel.query);
    ctx.addIssue({
      code: "custom",
      message: sql
        ? `a ${kind.kind} panel needs "query.timeField"`
        : `a ${kind.kind} panel needs a range query; remove "query.instant"`,
      path: ["query", sql ? "timeField" : "instant"],
    });
  }
  if (kind.query === "none") {
    // Nothing runs, so there is no window to own and nothing to refresh.
    for (const key of ["timeRange", "refreshIntervalMs", "links"] as const) {
      if (panel[key] !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: `a ${kind.kind} panel runs no query; remove "${key}"`,
          path: [key],
        });
      }
    }
  }
  const titles = new Set<string>();
  panel.links?.forEach((link, i) => {
    if (titles.has(link.title)) {
      ctx.addIssue({
        code: "custom",
        message: `duplicate link title "${link.title}"`,
        path: ["links", i, "title"],
      });
    }
    titles.add(link.title);
  });
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
    /**
     * Where the panel leads (#370): other dashboards in the workspace, or this
     * one with a variable set. Never on a kind that runs no query.
     */
    links: z.array(PanelLink).min(1).max(PANEL_LINKS_MAX).optional(),
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

/**
 * A generated panel of a kind that runs a query: `query` is required. A
 * generation over SQL sources only is shown the SQL branch alone, so its
 * prompt is what it was before PromQL existed; one with a Prometheus source is
 * shown both (#387), through {@link generationSchemas}.
 */
const GeneratedQueryPanel = PanelFields.extend({
  viz: z.enum(kindsWhere("required")),
  query: SqlQuery,
});

/** As {@link GeneratedQueryPanel}, in either language. */
const GeneratedAnyQueryPanel = PanelFields.extend({
  viz: z.enum(kindsWhere("required")),
  query: PanelQuery,
});

/** A generated panel of a kind that runs no query: it has no `query`. */
const GeneratedQuerylessPanel = PanelFields.omit({
  query: true,
  timeRange: true,
  refreshIntervalMs: true,
  links: true,
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
 * offered at all. Nor are links (#371): an explored panel is on no dashboard,
 * so it has nowhere to lead from.
 */
export const ExplorePanel = GeneratedQueryPanel.omit({ links: true }).superRefine(
  fitsItsKind,
);

/** {@link GeneratedPanel} in either query language (#387). */
export const GeneratedPanelAnyLanguage: z.ZodType<Panel> = z
  .discriminatedUnion("viz", [GeneratedAnyQueryPanel, GeneratedQuerylessPanel])
  .superRefine(fitsItsKind);

/** {@link ExplorePanel} in either query language (#387). */
export const ExplorePanelAnyLanguage = GeneratedAnyQueryPanel.omit({
  links: true,
}).superRefine(fitsItsKind);

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
 * A query's statement under the name of its language, for an audit row or a
 * log line: `{ sql }` or `{ promql }`, each of which the log reduces to a
 * digest.
 */
export function queryStatement(
  query: PanelQuery | VariableQuery,
): { sql: string } | { promql: string } {
  return isSqlQuery(query) ? { sql: query.sql } : { promql: queryText(query) };
}

/** A panel's time column, through {@link queryTimeField}; none for a panel with no query. */
export function panelTimeField(panel: Panel): string | undefined {
  return panel.query ? queryTimeField(panel.query) : undefined;
}

/** A panel's statement, through {@link queryText}; none for a panel with no query. */
export function panelQueryText(panel: Panel): string | undefined {
  return panel.query ? queryText(panel.query) : undefined;
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

/*
 * Dashboard variables (#67): see `Variable` below. The name and the value
 * shapes are declared here because a panel's links (#371) set them too.
 */

/** The most values a variable lists, or its query offers. */
export const VARIABLE_VALUES_MAX = 200;

/**
 * Where a `query` variable's values come from, against a source in the
 * dashboard's workspace, with no time filter and no variables of its own:
 *
 * - the first column of a guarded SELECT, for a SQL source;
 * - the values of a label (`label_values(match, label)` in Grafana's terms),
 *   optionally narrowed by a series selector the PromQL guard checks, for a
 *   Prometheus one.
 */
export const SqlVariableQuery = z
  .object({
    sourceId: z.string().min(1).max(128),
    sql: z.string().min(1).max(8_000),
  })
  .strict();

export const LabelValuesQuery = z
  .object({
    sourceId: z.string().min(1).max(128),
    /** The label whose values are offered. */
    label: z
      .string()
      .max(128)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a label name"),
    /** A series selector the values are narrowed to, such as `up{job="api"}`. */
    match: z.string().min(1).max(1_000).optional(),
  })
  .strict();

export const VariableQuery = z.union([SqlVariableQuery, LabelValuesQuery]);
export type VariableQuery = z.infer<typeof VariableQuery>;

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

/**
 * A self link (#371) sets this dashboard's variables in place, so it must set
 * at least one, and only ones the dashboard declares; otherwise it does
 * nothing, and the model should hear that at generation rather than a viewer
 * at click time. A link to another dashboard is not checked here: the IR
 * cannot see the target, and the target ignores a name it does not declare.
 */
function selfLinksSetDeclared(
  dash: { panels: Panel[]; variables?: Variable[] },
  ctx: z.RefinementCtx,
): void {
  const declared = declaredVariables(dash);
  dash.panels.forEach((panel, p) => {
    panel.links?.forEach((link, l) => {
      for (const problem of selfLinkProblems(link, declared)) {
        ctx.addIssue({
          code: "custom",
          message: problem.message,
          path: ["panels", p, "links", l, ...problem.path],
        });
      }
    });
  });
}

/**
 * What is wrong with a self link on a dashboard declaring `declared`: it sets
 * nothing, or it sets a name the dashboard does not declare. The editor shows
 * the same messages the schema refuses with (#374). Empty for a link to
 * another dashboard.
 */
export function selfLinkProblems(
  link: PanelLink,
  declared: ReadonlySet<string>,
): { path: string[]; message: string }[] {
  if (!isSelfLink(link)) return [];
  const names = Object.keys(link.set ?? {});
  if (names.length === 0) {
    return [
      {
        path: ["set"],
        message: `link "${link.title}" stays on this dashboard, so it must "set" a variable (or name a "dashboard")`,
      },
    ];
  }
  return names
    .filter((n) => !declared.has(n))
    .map((name) => ({
      path: ["set", name],
      message: `link "${link.title}" sets "${name}", which this dashboard does not declare`,
    }));
}

function dashboardRules(
  dash: { panels: Panel[]; variables?: Variable[] },
  ctx: z.RefinementCtx,
): void {
  uniqueIds(dash, ctx);
  selfLinksSetDeclared(dash, ctx);
}

export const Dashboard = z
  .object({
    specVersion: z.literal(SPEC_VERSION, {
      error: `specVersion must be ${SPEC_VERSION}; an older spec is read through StoredDashboard, which upgrades it`,
    }),
    ...DashboardFields,
  })
  .strict()
  .superRefine(dashboardRules);
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
  .superRefine(dashboardRules);
/**
 * {@link DashboardGenerationSchema} in either query language (#387): what a
 * generation with a Prometheus source is bound to, and what a client parses
 * any generated dashboard with, since it accepts everything the SQL one does.
 */
export const DashboardGenerationSchemaAnyLanguage = z
  .object({
    ...DashboardFields,
    panels: z.array(GeneratedPanelAnyLanguage).min(1).max(50),
  })
  .strict()
  .superRefine(dashboardRules);
export type GeneratedDashboard = z.infer<typeof DashboardGenerationSchemaAnyLanguage>;

/**
 * The schemas a generation is bound to: SQL only unless one of its sources
 * answers PromQL, so a generation over SQL sources is asked for exactly what
 * it was before PromQL existed.
 */
export function generationSchemas(promql: boolean) {
  return promql
    ? {
        dashboard: DashboardGenerationSchemaAnyLanguage,
        panel: GeneratedPanelAnyLanguage,
        explore: ExplorePanelAnyLanguage,
      }
    : {
        dashboard: DashboardGenerationSchema,
        panel: GeneratedPanel,
        explore: ExplorePanel,
      };
}

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
