import { type LanguageModelUsage, streamObject } from "ai";
import type { z } from "zod";
import { describeFailure, type Failure, repairPrompt } from "@/lib/ai/repair";
import { type Model, modelSettings } from "@/lib/ai/provider";
import {
  dashboardsBlock,
  linkableIds,
  linksGuide,
  type PromptDashboard,
  workspaceContextBlock,
} from "@/lib/ai/prompt";
import { withCompiledCustomVisuals } from "@/lib/ai/custom-visuals";
import { withKnownLinkTargets } from "@/lib/ai/link-targets";
import { withSourceLanguages } from "@/lib/ai/source-languages";
import { sourceKind } from "@/lib/sources/registry";
import { serverKind } from "@/lib/sources/server/registry";
import {
  type Dashboard,
  forGeneration,
  type Panel,
  generationSchemas,
  type QueryLanguage,
} from "@/lib/ir";
import { config } from "@/lib/config";
import { PANEL_KINDS } from "@/lib/panels/registry";
import { ModelSourceDraft, type SourceRecord } from "@/lib/registry";
import { MAX_ADDITIONAL_SOURCES } from "@/lib/source-selection";
import type { WorkspacePrompt } from "@/lib/workspace-prompt";

/**
 * LLM generation.
 *
 * The model runs EXACTLY ONCE per author action (create / refine a turn / full
 * edit / single panel NL edit), plus at most one repair when that run's output
 * fails its schema (#21, ./repair.ts). Each function takes the failure to
 * repair as `repair`; the rest of the prompt is unchanged.
 *
 * The model only ever emits a validated spec conforming to the shared Zod IR —
 * never data. The prompt contains catalog METADATA for the selected,
 * already-authorized source, or for a dashboard up to three of one workspace
 * (#104). The model must not write time filters;
 * the server injects the dashboard time range at execution.
 */

/**
 * What a finished generation reports back to its route.
 *
 * One callback rather than two: the route has to spend the usage against the
 * workspace's budget AND record the prompt/spec pair (#23), and both want the
 * same moment. Keeping it to one hook means a new generation path cannot wire
 * up half of that by accident.
 */
export interface GenerationFinish {
  /** The validated object, or undefined when the run produced none. */
  object: unknown;
  usage: LanguageModelUsage;
  /** A schema-validation or provider failure, when there was one. */
  error: unknown;
  /** The model the provider says answered, which can be more specific than AI_MODEL. */
  modelId: string;
  /**
   * Why the output failed the schema, worked out here against the schema the
   * call used; null on success or when the failure was not the output's shape.
   * What a repair (#21) is built from.
   */
  failure: Failure | null;
}

/** The prompt, or the repair prompt built on it when this run is a repair (#21). */
function withRepair(repair: Failure | undefined, prompt: string): string {
  return repair ? repairPrompt(prompt, repair) : prompt;
}

/**
 * Reports a finished call. The routes pass a handler that spends the usage
 * against the workspace's budget and writes the generation log row.
 */
export type OnGenerationFinish = (event: GenerationFinish) => void;

/**
 * Adapt `streamObject`'s finish event to {@link GenerationFinish}. Async,
 * because a failure is worked out against a schema that may compile a custom
 * visual (#405); the SDK awaits it before the stream closes, so a repair
 * request still finds the failure remembered.
 */
function finish(onFinish: OnGenerationFinish | undefined, schema: z.ZodType) {
  return async (event: {
    object: unknown;
    usage: LanguageModelUsage;
    error: unknown;
    response: { modelId?: string };
  }) =>
    onFinish?.({
      object: event.object,
      usage: event.usage,
      error: event.error,
      modelId: event.response.modelId ?? "",
      failure:
        event.object === undefined ? await describeFailure(event.error, schema) : null,
    });
}

/**
 * The schemas a generation over `sources` is bound to: SQL only unless one
 * of them answers another language (PromQL #387, LogQL #564), so a SQL
 * generation is asked for exactly what it always was.
 */
function schemasFor(sources: readonly SourceRecord[]) {
  const anyLanguage = !onlySql(sourceLanguages(sources));
  const schemas = generationSchemas(anyLanguage);
  if (!anyLanguage) return schemas;
  // A panel in the other language fails the schema, so the repair names the
  // field to write; a SQL generation is bound exactly as it was.
  const languages = Object.fromEntries(
    sources.map((s) => [s.id, sourceKind(s).language]),
  );
  return {
    dashboard: withSourceLanguages(schemas.dashboard, languages),
    panel: withSourceLanguages(schemas.panel, languages),
    explore: withSourceLanguages(schemas.explore, languages),
  };
}

/** The most sources one generation may be given (#104): the primary and its others. */
export const MAX_GENERATION_SOURCES = 1 + MAX_ADDITIONAL_SOURCES;

const SINGLE_SOURCE_RULE =
  "- Every panel's query.sourceId MUST equal the provided sourceId.";

const MULTI_SOURCE_RULE = `- Every panel's query.sourceId MUST be one of the provided sourceIds, and its SQL
  may reference ONLY tables from the catalog block of THAT source. Never use a
  table from one source's catalog under another sourceId, and never join or
  combine tables from different sources in one query.`;

export const SQL_RULES = `SQL rules (STRICT):
- Emit TimescaleDB/PostgreSQL SELECT statements only. No INSERT/UPDATE/DDL, no semicolons, no comments.
- Reference ONLY tables listed in the catalog for the given source.
- Do NOT add any time filter, now()/today(), or WHERE on the time column: the
  server injects the dashboard time range automatically on 'query.timeField'.
- The server filters time on the OUTPUT column named by 'query.timeField', so
  that name MUST be an alias present in your SELECT list — NEVER the raw catalog
  time column. For time-series (line/bar/heatmap) bucket the time column, alias
  it, and set that alias as 'query.timeField'. Always ORDER BY it ASC. Example:
  SELECT time_bucket('1 minute', ts) AS minute, count(*) AS requests
  FROM http_requests GROUP BY minute ORDER BY minute  ->  timeField "minute".
- OMIT 'query.timeField' when the result has no time column (a 'stat' scalar or a
  group-by-dimension breakdown). Never name a column that is not in the output.
${SINGLE_SOURCE_RULE}
- Keep result sets small; the server also enforces row limits.`;

/**
 * The SQL rules for a generation over `sourceCount` sources. One source gets
 * {@link SQL_RULES} exactly, so a single-source prompt is unchanged by #104.
 */
export function sqlRules(sourceCount: number): string {
  return sourceCount > 1
    ? SQL_RULES.replace(SINGLE_SOURCE_RULE, MULTI_SOURCE_RULE)
    : SQL_RULES;
}

const PROMQL_SINGLE_SOURCE_RULE =
  "- Every panel's query.sourceId MUST equal the provided sourceId.";

const PROMQL_MULTI_SOURCE_RULE = `- Every panel's query.sourceId MUST be one of the provided sourceIds, and its
  PromQL may name ONLY metrics from the catalog block of THAT source.`;

/**
 * The PromQL rules (#387), in the voice of {@link SQL_RULES}, for a source
 * whose catalog says `kind: prometheus`. They are the guard's rules said
 * forward (`src/lib/promql/safety.ts`), plus what makes a query worth drawing.
 */
export const PROMQL_RULES = `PromQL rules (STRICT) — for a source whose catalog says kind: prometheus:
- Write the panel's query as 'query.promql': ONE PromQL expression, no comments.
  Never 'query.sql' and never 'query.timeField' for this source.
- Every selector MUST name a metric listed in that source's catalog, by its name:
  http_requests_total{job="api"}. Never a selector without a metric name, never
  a __name__ pattern.
- NEVER use the @ modifier and never write a time of your own: the server sets
  start, end and step. Keep ranges, subqueries and offsets within 7d.
- A counter (catalog type counter) is plotted through rate() or increase() over a
  range of at least four scrape intervals, e.g. rate(x[5m]); never a raw
  counter. A gauge is plotted as it is.
- Keep series few: aggregate with sum by (<label>) (...) on labels the catalog
  lists for the metric.
- Latency percentiles: histogram_quantile(0.95, sum by (le) (rate(<name>_bucket[5m])))
  over a *_bucket metric with an "le" label.
- Set "instant": true for a stat, gauge, pie, donut, status-grid, histogram, treemap, graph, sankey or table panel (one value per
  series, at the end of the window). Leave it out for a time series: its rows
  carry a "time" column, and the chart draws one line per series.
- A dashboard variable appears ONLY as a whole label-matcher value: {host=":host"},
  or {host=~":host"} for a multi variable. Never anywhere else.
${PROMQL_SINGLE_SOURCE_RULE}`;

const LOGQL_SINGLE_SOURCE_RULE =
  "- Every panel's query.sourceId MUST equal the provided sourceId.";

const LOGQL_MULTI_SOURCE_RULE = `- Every panel's query.sourceId MUST be one of the provided sourceIds, and its
  LogQL may match ONLY labels from the catalog block of THAT source.`;

/**
 * The LogQL rules (#564), in the voice of {@link PROMQL_RULES}, for a source
 * whose catalog says `kind: loki`. They are the LogQL guard's rules said
 * forward (`src/lib/logql/safety.ts`), the kind's refusal of an instant log
 * query, and what makes a logs panel worth reading.
 */
export const LOGQL_RULES = `LogQL rules (STRICT) — for a source whose catalog says kind: loki:
- Write the panel's query as 'query.logql': ONE LogQL expression, no comments.
  Never 'query.sql', 'query.promql' or 'query.timeField' for this source.
- Every stream selector MUST carry an = matcher, with a value, on a label listed
  in that source's catalog: {app="api"}. Never {}, and never a selector of
  regex or != matchers alone.
- NEVER write a time of your own: no offset, no absolute time. The server sets
  start, end, step and how many lines come back. Keep [ranges] within 7d.
- A 'logs' panel is a LOG query, a selector and then its filters and parsers:
  {app="api"} |= "error". Never write a LIMIT; set the panel's options.limit
  (for example 200) to how many lines to show.
- Every other kind draws a METRIC query over a log query. It answers in
  PromQL's shape, so a kind's hint said for PromQL or a Prometheus source holds
  for it too, written in LogQL:
  sum by (route) (count_over_time({app="api"} | json [5m])), or rate(...).
- Filter or group on a field inside the line only after parsing it with
  | json or | logfmt: {app="api"} | json | status >= 500.
- Set "instant": true only on a metric query, for a stat, gauge, pie, donut,
  status-grid, histogram, treemap, graph, sankey or table panel. A log query is NEVER instant:
  it is refused.
- A log query's rows are each line's time, its text as "message" and its labels,
  so leave options.message out. When the catalog lists a level label, or the
  lines carry a level field you parse, name it in options.level.
- A dashboard variable appears ONLY as a whole matcher value with = or !=
  ({env=":env"}, | level=":level") or as the string of a |= or != line filter
  (|= ":needle"). Never in a regex (=~, !~, |~), and never a multi variable.
${LOGQL_SINGLE_SOURCE_RULE}`;

/** Which languages a generation's sources answer. */
export function sourceLanguages(sources: readonly SourceRecord[]): Set<QueryLanguage> {
  return new Set(sources.map((s) => sourceKind(s).language));
}

/** Whether every source answers SQL, so the prompt is the SQL one exactly. */
function onlySql(languages: ReadonlySet<QueryLanguage>): boolean {
  return !languages.has("promql") && !languages.has("logql");
}

/** How the prompt's first lines name the query a panel carries. */
function queryNoun(languages: ReadonlySet<QueryLanguage>): string {
  if (languages.has("logql")) return "a SQL, PromQL or LogQL query";
  return languages.has("promql") ? "a SQL or PromQL query" : "SQL";
}

/** The field each language is written in, and the catalog kind that says so. */
const LANGUAGE_FIELDS: readonly [QueryLanguage, string, string][] = [
  ["sql", "sql", "timescaledb"],
  ["promql", "promql", "prometheus"],
  ["logql", "logql", "loki"],
];

/**
 * The query rules for a generation over `sources`. Sources that all answer
 * SQL get {@link sqlRules} exactly, so a SQL prompt is unchanged by #387. A
 * Prometheus source adds {@link PROMQL_RULES}, a Loki source
 * {@link LOGQL_RULES} (#564), and a mix adds the rule that a panel's language
 * is its source's.
 */
export function queryRules(sources: readonly SourceRecord[]): string {
  const languages = sourceLanguages(sources);
  if (onlySql(languages)) return sqlRules(sources.length);
  const many = sources.length > 1;
  const rules: string[] = [];
  if (languages.has("sql")) rules.push(sqlRules(sources.length));
  if (languages.has("promql")) {
    rules.push(
      many
        ? PROMQL_RULES.replace(PROMQL_SINGLE_SOURCE_RULE, PROMQL_MULTI_SOURCE_RULE)
        : PROMQL_RULES,
    );
  }
  if (languages.has("logql")) {
    rules.push(
      many
        ? LOGQL_RULES.replace(LOGQL_SINGLE_SOURCE_RULE, LOGQL_MULTI_SOURCE_RULE)
        : LOGQL_RULES,
    );
  }
  if (rules.length === 1) return rules[0];
  // Worded for SQL and PromQL exactly as it was before LogQL (#387).
  const fields = LANGUAGE_FIELDS.filter(([l]) => languages.has(l))
    .map(([, field, kind], i) =>
      i === 0
        ? `'query.${field}' for a source whose\n  catalog says kind: ${kind}`
        : `'query.${field}' for kind: ${kind}`,
    )
    .join(", ");
  return `${rules.join("\n\n")}

- Each panel's query language is its source's: ${fields}.`;
}

/**
 * The kinds a panel can be, for a generation over these languages. SQL alone
 * gets {@link VIZ_GUIDE} exactly; PromQL takes each kind's `promqlHint` where
 * it has one, LogQL its `logqlHint` or else its PromQL one (a metric query
 * answers in PromQL's shape), and a mix gives each that differs.
 */
export function vizGuide(languages: ReadonlySet<QueryLanguage>): string {
  if (onlySql(languages)) return VIZ_GUIDE;
  return PANEL_KINDS.map((k) => {
    const hints: [string, string][] = [];
    if (languages.has("sql")) hints.push(["SQL", k.promptHint]);
    if (languages.has("promql")) hints.push(["PromQL", k.promqlHint ?? k.promptHint]);
    if (languages.has("logql")) {
      hints.push(["LogQL", k.logqlHint ?? k.promqlHint ?? k.promptHint]);
    }
    const said: string[] = [];
    const parts = hints.flatMap(([name, hint]) => {
      if (said.includes(hint)) return [];
      said.push(hint);
      return [said.length === 1 ? hint : `With ${name}: ${hint}`];
    });
    return `- '${k.kind}': ${parts.join(" ")}`;
  }).join("\n");
}

/** How a PromQL dashboard declares a variable (#383): the values of a label. */
const PROMQL_VARIABLES_GUIDE = `- For a Prometheus source, a 'query' variable lists a label's values:
  {"name":"host","type":"query","query":{"sourceId":"<this source>","label":"instance","match":"up{job="api"}"}}.
  'match' is ONE selector of a listed metric, or omit it.`;

/** How a LogQL dashboard declares a variable (#564): the values of a stream label. */
const LOGQL_VARIABLES_GUIDE = `- For a Loki source, a 'query' variable lists a stream label's values:
  {"name":"app","type":"query","query":{"sourceId":"<this source>","label":"app","match":"{env=\\"prod\\"}"}}.
  'match' is ONE stream selector on listed labels, or omit it.`;

/**
 * Every panel carries its own one-sentence explanation.
 *
 * `Panel.description` has always been in the IR and was asked for only by the
 * explore prompt, so a dashboard panel titled "p95 latency" left the reader
 * nothing short of the SQL. The wording is the explore prompt's, promoted to
 * the shared system prompt: intent, never values. A description that quoted a
 * number would be the model reporting data, which is the one thing it must not
 * do (invariant 2).
 */
export const DESCRIPTION_RULE = `Every panel MUST carry a "description": ONE sentence
saying WHAT the query computes — the measure, the grouping and the unit — phrased
as intent. NEVER state, estimate or invent a result value, a threshold or a
trend; you have not seen the data.`;

/**
 * The kinds a panel can be, one line each, built from the panel registry
 * (#61): a kind that is registered is offered to the model, and one that is
 * not cannot be, because the list and the IR's enum are the same list.
 */
export const VIZ_GUIDE = PANEL_KINDS.map((k) => `- '${k.kind}': ${k.promptHint}`).join(
  "\n",
);

/**
 * Presentation options and per-panel overrides (#114, #115). All optional:
 * the model is told when they earn their place, so a plain request still
 * produces a plain spec.
 */
export const PRESENTATION_GUIDE = `Optional per-panel settings; omit each unless the request calls for it:
- 'options' on line/area/bar: decimals (0-6), unit (e.g. "req/s"), compact (true for 1.2K), legend ("top"|"bottom"|"right"|"none"), yAxis {min, max, log, label}, stacked (true), thresholds [{value, color}] ascending, and on line/area only curve ("straight", the default, joins samples with segments; "step" holds each value until the next sample, for counters, states and anything that changes in jumps: replica counts, deploys, a circuit breaker, errors per minute; "smooth" rarely, only when the reader wants the trend rather than the samples).
- 'options' on stat: value (the column to show), decimals, unit, compact, thresholds, sparkline (true to draw the column's history behind the number), curve ("straight"|"step", the sparkline's, as on line).
- 'options' on pie/donut: decimals, unit, compact, legend.
- 'options' on status-grid: entity (the label column), value, thresholds, or state with states [{state, color}], sort ("label"|"value"|"none"), decimals, unit, compact.
- 'options' on histogram: bucket, count (the columns), cumulative (true for Prometheus "le" buckets), log (true for a long tail), thresholds (colors bars from a bucket bound, e.g. an SLO), decimals, unit, compact (for the bucket labels).
- 'options' on logs: message, level (the columns), levels [{state, color}], wrap, order ("newest"|"oldest"), showTime.
- 'options' on treemap: path (columns, top level first), value, variant ("treemap"|"sunburst"), decimals, unit, compact.
- 'options' on graph: layout ("tree", "dag" when a node has several parents or the edges can cycle, or "force" for undirected who-talks-to-whom clouds), node ("block" draws each node as a box with its name inside, for an architecture or service map, a lineage, a pipeline or a flowchart; the default "marker" for a large or dense graph), orient ("LR"|"TB"|"RL"|"BT"|"radial", the tree's), direction ("LR"|"TB", the dag's), edgeLabels (true writes each edge's value on a dag or force graph), curve (false draws a dag's edges straight), source and target (the parent and child columns of an edge row), value (on force, also sizes nodes), group (a text column that colors nodes), path (columns, top level first, instead of source/target), collapseDepth (levels open at first), symbol (circle, rect, roundRect, triangle, diamond, pin, arrow, or an icon: server, database, cloud, router, switch, firewall, loadBalancer, queue, cache, storage, user, service; use icons for infrastructure and service maps), symbols ({group value: symbol}), symbolSize (6-48), decimals, unit, compact.
- 'options' on sankey: value (REQUIRED, the volume of each flow), path (2+ columns, one stage each, first stage first) or source and target (the from and to columns of an edge row), group (a text column that colors nodes), orient ("LR"|"TB"), decimals, unit, compact. Flows must not cycle.
- 'options' on vega: spec, a Vega-Lite spec with "data": {"name": "rows"}, encoding the query's columns; colors only as token names or palette-0..palette-5; no url, href, image, datasets, values, config or scheme. Use it only when no other kind draws the view.
- 'options' on table: columns [{name, label, hidden, format, decimals, unit, align}] (listed first, in order), sort {column, order: "asc"|"desc"}.
- Colors are tokens only: success, warning, danger, info, neutral, orange, purple, teal.
- 'timeRange' and 'refreshIntervalMs' on a panel override the dashboard's, for a panel that needs a different window or cadence than the rest (e.g. a "today so far" stat over {from:"now-24h", to:"now"} refreshed every 300000ms). Never on a text panel.`;

/**
 * Dashboard variables (#67). The model may declare them and reference them;
 * the values are bound by the server, never written into the SQL.
 */
export const VARIABLES_GUIDE = `Dashboard 'variables' are optional; declare one only when the request asks to switch the dashboard between values of a dimension (per host, per region):
- {"name":"host","type":"query","query":{"sourceId":"<this source>","sql":"SELECT DISTINCT host FROM <table> ORDER BY 1"}} lists values from the catalog; {"name":"env","type":"enum","values":["prod","staging"]} lists them literally. Add "multi": true to allow several.
- Reference a variable in panel SQL as :host (e.g. WHERE host = :host), or for a multi variable as host = ANY(:host). Never quote it and never write a value into the SQL; the server binds it.
- A variable's own query has no time filter and references no variable.`;

/** The kinds explore may plot when a question asks for a chart. Never text. */
const CHART_KINDS = PANEL_KINDS.filter((k) => k.canvas)
  .map((k) => `"${k.kind}"`)
  .join(", ");

/**
 * Which sources a generation may use, and what each one holds. One source is
 * the prompt as it has always been. Several (#104, at most
 * {@link MAX_GENERATION_SOURCES}, all already authorized by the caller) each
 * get their own fenced catalog block under a heading naming the source, so a
 * table is always attributable to the one source whose catalog it is in.
 */
function sourcesSection(sources: readonly SourceRecord[]): string {
  if (sources.length === 1) {
    const [source] = sources;
    return `The only authorized data source for this request:
sourceId: ${source.id}

Catalog (metadata only):
${serverKind(source).catalogPrompt(source)}`;
  }
  const ids = sources.map((s) => `sourceId: ${s.id}`).join("\n");
  const catalogs = sources
    .map(
      (s) =>
        `Catalog for sourceId "${s.id}" (metadata only):\n${serverKind(s).catalogPrompt(s)}`,
    )
    .join("\n\n");
  return `The authorized data sources for this request (each panel uses exactly ONE):
${ids}

${catalogs}`;
}

/**
 * The system prompt every spec generation shares: the base rules, the fenced
 * catalog of each source, the workspace's own context when it has one (#66),
 * and then the rules, so the last word before the model reads the request is
 * ours. Exported so the settings page shows editors the prompt the model is
 * given.
 *
 * `additionalSources` (#104) are the dashboard modes' other sources, in the
 * same workspace as `source`; the caller has authorized each one.
 */
export function baseSystem(
  source: SourceRecord,
  workspacePrompt?: WorkspacePrompt | null,
  additionalSources: readonly SourceRecord[] = [],
  /**
   * The dashboards a link may lead to (#375), as the server listed them for
   * this caller in this workspace. Absent: a request that writes no links
   * (explore), and the link rules are left out. Empty: self links only.
   */
  dashboards?: readonly PromptDashboard[],
): string {
  const sources = [source, ...additionalSources];
  if (sources.length > MAX_GENERATION_SOURCES) {
    throw new Error(`a generation takes at most ${MAX_GENERATION_SOURCES} sources`);
  }
  const workspace = workspaceContextBlock(
    workspacePrompt,
    sources.map((s) => s.id),
  );
  const targets = dashboardsBlock(dashboards);
  const hasTargets = linkableIds(dashboards ?? []).length > 0;
  const languages = sourceLanguages(sources);
  const promql = languages.has("promql");
  const logql = languages.has("logql");
  return `You design monitoring dashboards as a strict JSON spec.
You NEVER return data rows — only a viz specification (${queryNoun(languages)} + layout).

${sourcesSection(sources)}
${workspace ? `\n${workspace}\n` : ""}${targets ? `\n${targets}\n` : ""}
${queryRules(sources)}

${DESCRIPTION_RULE}

Layout: a 12-column grid. By DEFAULT place two panels side by side (w=6 each)
and 4 rows tall (h=4), laid out left-to-right, top-to-bottom, without overlaps.
Use a wider or taller panel only when a request clearly calls for it.

Choose each panel's 'viz' from these kinds, and no other:
${vizGuide(languages)}

Use 'format' (number|bytes|percent|ms) where meaningful.

${PRESENTATION_GUIDE}

${VARIABLES_GUIDE}${promql ? `\n${PROMQL_VARIABLES_GUIDE}` : ""}${logql ? `\n${LOGQL_VARIABLES_GUIDE}` : ""}${dashboards === undefined ? "" : `\n\n${linksGuide(hasTargets)}`}`;
}

/**
 * What a dashboard generation sends the model: the schema it is bound to and
 * the prompts. Separate from {@link streamDashboard} so the eval harness (#24)
 * grades the exact request the route makes.
 */
export function dashboardRequest(input: {
  /** The dashboard's other sources (#104), same workspace, already authorized. */
  additionalSources?: readonly SourceRecord[];
  source: SourceRecord;
  prompt: string;
  /** The workspace's prompt customization (#66), when it has one. */
  workspacePrompt?: WorkspacePrompt | null;
  /** Set when this run repairs a failed one (#21). */
  repair?: Failure;
  /** The dashboards a link may lead to (#375). */
  dashboards?: readonly PromptDashboard[];
}) {
  const { source, prompt, repair, workspacePrompt, additionalSources, dashboards } =
    input;
  const schemas = schemasFor([source, ...(additionalSources ?? [])]);
  return {
    schema: withCompiledCustomVisuals(linkedSchema(schemas.dashboard, dashboards)),
    schemaName: "Dashboard",
    schemaDescription: "A monitoring dashboard specification (viz spec, not data).",
    system: baseSystem(source, workspacePrompt, additionalSources, dashboards),
    prompt: withRepair(
      repair,
      `Create a dashboard for this request:\n"""${prompt}"""\n
Use refreshIntervalMs=${config.defaultRefreshIntervalMs} and timeRange {from:"${config.defaultTimeFrom}", to:"${config.defaultTimeTo}"} unless the request clearly implies otherwise.`,
    ),
  };
}

/**
 * A generation schema held to the listed link targets (#375), when there is
 * a list; the schema itself when there is none (explore, which writes none).
 */
function linkedSchema<S extends z.ZodType>(
  schema: S,
  dashboards: readonly PromptDashboard[] | undefined,
): S {
  return dashboards === undefined
    ? schema
    : withKnownLinkTargets(schema, linkableIds(dashboards));
}

export function streamDashboard(input: {
  /** The dashboards a link may lead to (#375). */
  dashboards?: readonly PromptDashboard[];
  additionalSources?: readonly SourceRecord[];
  source: SourceRecord;
  prompt: string;
  /** The workspace's prompt customization (#66), when it has one. */
  workspacePrompt?: WorkspacePrompt | null;
  onFinish?: OnGenerationFinish;
  /** The model this caller resolved to in this workspace (#331). */
  model: Model;
  /** Set when this run repairs a failed one (#21). */
  repair?: Failure;
}) {
  const request = dashboardRequest(input);
  return streamObject({
    ...modelSettings(input.model),
    onFinish: finish(input.onFinish, request.schema),
    ...request,
  });
}

/**
 * Ad-hoc exploration: generate a SINGLE panel spec that best answers a plain
 * natural-language question against the given source. Same invariants as every
 * other generation path — the model emits only a validated Panel (SQL + viz),
 * never data, and never a time filter (the server injects the range).
 */
/** What an explore generation sends the model; see {@link dashboardRequest}. */
export function explorePanelRequest(input: {
  source: SourceRecord;
  prompt: string;
  /** The workspace's prompt customization (#66), when it has one. */
  workspacePrompt?: WorkspacePrompt | null;
  /** Set when this run repairs a failed one (#21). */
  repair?: Failure;
}) {
  const { source, prompt, repair, workspacePrompt } = input;
  return {
    schema: schemasFor([source]).explore,
    schemaName: "Panel",
    schemaDescription: "A single panel specification (viz spec, not data).",
    system: baseSystem(source, workspacePrompt),
    prompt: withRepair(
      repair,
      `Answer this question with a SINGLE panel:
"""${prompt}"""

Return one Panel. Give it a concise title, use id "explore", and set layout to
{"x":0,"y":0,"w":12,"h":4}.

Viz selection (IMPORTANT — default to text/tabular output):
- Default to viz "table" and return the relevant rows/columns. Never use "text":
  explore answers from data.
- Use "stat" only when the question asks for a single scalar value.
- Use a chart viz (${CHART_KINDS}) ONLY when the
  request explicitly asks to chart/plot/graph/visualize the data or to see a
  trend over time. Use "pie"/"donut" for share/proportion/breakdown questions
  across a small set of categories.`,
    ),
  };
}

export function streamExplorePanel(input: {
  source: SourceRecord;
  prompt: string;
  /** The workspace's prompt customization (#66), when it has one. */
  workspacePrompt?: WorkspacePrompt | null;
  onFinish?: OnGenerationFinish;
  /** The model this caller resolved to in this workspace (#331). */
  model: Model;
  /** Set when this run repairs a failed one (#21). */
  repair?: Failure;
}) {
  const request = explorePanelRequest(input);
  return streamObject({
    ...modelSettings(input.model),
    onFinish: finish(input.onFinish, request.schema),
    ...request,
  });
}

/**
 * Draft a data-source registration from a plain-English description. The model
 * emits ONLY a validated SourceDraft — the safe connection config and a
 * best-effort table catalog — never credentials and never live data. The user
 * reviews the draft, then Tests connectivity and Refreshes the catalog against
 * the live database (which is the source of truth for real columns) before it
 * is persisted. There is no source to authorize against yet, so unlike the
 * dashboard paths this prompt carries no catalog metadata.
 *
 * `grantedSecretRefs` are the refs the workspace may use — names the operator
 * declared, never credentials — so the draft picks one that will resolve.
 * The prompt is advice, not enforcement: creating the source is what refuses
 * a ref the workspace is not granted.
 */
export function streamSourceDraft(input: {
  prompt: string;
  grantedSecretRefs: readonly string[];
  /**
   * The kind the caller says the source is (#389), as its label, such as
   * "Prometheus". Absent, the model decides from the description, and the
   * prompt is what it always was.
   */
  kindLabel?: string;
  onFinish?: OnGenerationFinish;
  /** The model this caller resolved to in this workspace (#331). */
  model: Model;
  /** Set when this run repairs a failed one (#21). */
  repair?: Failure;
}) {
  const { prompt, grantedSecretRefs, onFinish, repair } = input;
  const refRule =
    grantedSecretRefs.length > 0
      ? `'secretRef' MUST be one of: ${grantedSecretRefs.map((r) => JSON.stringify(r)).join(", ")}.
  Pick the one that best matches the description; do not invent another.`
      : `No 'secretRef' is granted to this workspace yet. Use "TS_METRICS"; the
  user will choose a granted one before creating the source.`;
  return streamObject({
    ...modelSettings(input.model),
    onFinish: finish(onFinish, ModelSourceDraft),
    schema: ModelSourceDraft,
    schemaName: "SourceDraft",
    schemaDescription:
      "A data source registration — TimescaleDB/PostgreSQL (connection plus a table catalog) or Prometheus (URL, auth mode plus a metric catalog). Never contains credentials.",
    system: `You draft data-source registrations for a monitoring dashboard tool,
from a plain-English description. A source is EITHER a TimescaleDB/PostgreSQL
database OR a Prometheus-compatible HTTP endpoint (Prometheus, Thanos, Mimir,
VictoriaMetrics); decide which from the description.

You emit ONLY a JSON spec describing how to CONNECT and WHAT tables exist. You
NEVER emit data rows.

CRITICAL security rules:
- NEVER include a username, password, or connection string. Credentials are
  resolved at runtime on the server from the reference named by 'secretRef';
  do not invent any credential value.
- ${refRule}
- If the description contains a password or secret, ignore it entirely.

Field rules:
- 'id': lowercase slug, e.g. "ts-metrics". Derive it from the name/purpose.
- 'name': a short human-readable label.
- 'config.host'/'config.port'/'config.database': from the description; default
  port to 5432. When the description gives no host or database, or gives a
  placeholder in angle brackets such as <host> or <database>, emit exactly
  "<host>" / "<database>". NEVER invent a plausible-looking host or database
  name: the form refuses to save a placeholder, which is the point. 'config.schema' defaults to "public"; 'config.ssl' defaults to false.
- 'config.tables': list the tables the user describes. For each, include its
  columns with a reasonable PostgreSQL 'type', and set 'timeField' to the time
  column when there is one (used for server-injected time filtering). If the
  user names no tables/columns, emit a single reasonable placeholder table so
  the draft validates — the user will Refresh it against the live database.

For a Prometheus endpoint, 'config' is instead:
- 'config.kind': exactly "prometheus".
- 'config.url': the endpoint's base URL, https unless the description says it
  is an in-cluster http address. NEVER put credentials in it. When none is
  given, emit exactly "https://prometheus.example.com".
- 'config.auth': "bearer", "basic" or "none". Use "none" only for an endpoint
  the description says needs no authentication; then OMIT 'secretRef'.
- 'config.metrics': the metrics the user describes, each with 'name', 'type'
  ("counter", "gauge", "histogram", "summary" or "unknown"), and the 'labels'
  its series carry when the description names them. If none are named, emit
  "up" (type "gauge", labels ["job", "instance"]) so the draft validates — the
  user will discover the real ones.`,
    prompt: withRepair(
      repair,
      `Draft a data source for this description:\n"""${prompt}"""${
        input.kindLabel ? `\nThe source is a ${input.kindLabel} source.` : ""
      }`,
    ),
  });
}

export function streamPanel(input: {
  source: SourceRecord;
  prompt: string;
  /** The workspace's prompt customization (#66), when it has one. */
  workspacePrompt?: WorkspacePrompt | null;
  current: Panel;
  onFinish?: OnGenerationFinish;
  /** The model this caller resolved to in this workspace (#331). */
  model: Model;
  /** Set when this run repairs a failed one (#21). */
  repair?: Failure;
  /** The dashboards a link may lead to (#375). */
  dashboards?: readonly PromptDashboard[];
}) {
  const { source, prompt, current, onFinish, repair, workspacePrompt, dashboards } =
    input;
  const schema = withCompiledCustomVisuals(
    linkedSchema(schemasFor([source]).panel, dashboards),
  );
  return streamObject({
    ...modelSettings(input.model),
    onFinish: finish(onFinish, schema),
    schema,
    schemaName: "Panel",
    schemaDescription: "A single dashboard panel specification (viz spec, not data).",
    system: baseSystem(source, workspacePrompt, [], dashboards),
    prompt: withRepair(
      repair,
      `Here is the current panel spec:
${JSON.stringify(current, null, 2)}

Apply this change and return the full updated panel (keep the same "id"):
"""${prompt}"""`,
    ),
  });
}

/**
 * Conversational refinement of a dashboard that has not been saved yet. Mirrors
 * {@link streamPanel} one level up: the current full spec plus a follow-up
 * instruction, returning the complete updated dashboard. It is still one model
 * call per author action — a turn, not a chat loop — and the model still emits
 * only a validated spec, never data.
 */
export function streamDashboardRefinement(input: {
  /** The dashboard's other sources (#104), same workspace, already authorized. */
  additionalSources?: readonly SourceRecord[];
  source: SourceRecord;
  prompt: string;
  /** The workspace's prompt customization (#66), when it has one. */
  workspacePrompt?: WorkspacePrompt | null;
  current: Dashboard;
  onFinish?: OnGenerationFinish;
  /** The model this caller resolved to in this workspace (#331). */
  model: Model;
  /** Set when this run repairs a failed one (#21). */
  repair?: Failure;
  /** The dashboards a link may lead to (#375). */
  dashboards?: readonly PromptDashboard[];
}) {
  const {
    source,
    prompt,
    current,
    onFinish,
    repair,
    workspacePrompt,
    additionalSources,
    dashboards,
  } = input;
  const schema = linkedSchema(
    schemasFor([source, ...(additionalSources ?? [])]).dashboard,
    dashboards,
  );
  return streamObject({
    ...modelSettings(input.model),
    onFinish: finish(onFinish, schema),
    schema,
    schemaName: "Dashboard",
    schemaDescription: "A monitoring dashboard specification (viz spec, not data).",
    system: baseSystem(source, workspacePrompt, additionalSources, dashboards),
    prompt: withRepair(
      repair,
      `Here is the current dashboard spec:
${JSON.stringify(forGeneration(current), null, 2)}

Apply this change and return the FULL updated dashboard:
"""${prompt}"""

Carry over every panel the request does not mention, unchanged and with the same
"id". Keep "title", "timeRange" and "refreshIntervalMs" unless the request asks
to change them.`,
    ),
  });
}
