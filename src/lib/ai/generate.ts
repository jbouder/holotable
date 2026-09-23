import { type LanguageModelUsage, streamObject } from "ai";
import { getModel } from "@/lib/ai/provider";
import { buildCatalogPrompt } from "@/lib/timescaledb/catalog";
import { Dashboard, Panel } from "@/lib/ir";
import { config } from "@/lib/config";
import { SourceDraft, type SourceRecord } from "@/lib/registry";

/**
 * LLM generation.
 *
 * The model runs EXACTLY ONCE per author action (create / refine a turn / full
 * edit / single panel NL edit) and only ever emits a validated spec conforming
 * to the shared Zod IR — never data. The prompt contains catalog METADATA for the single
 * selected, already-authorized source. The model must not write time filters;
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
}

/**
 * Reports a finished call. The routes pass a handler that spends the usage
 * against the workspace's budget and writes the generation log row.
 */
export type OnGenerationFinish = (event: GenerationFinish) => void;

/** Adapt `streamObject`'s finish event to {@link GenerationFinish}. */
function finish(onFinish: OnGenerationFinish | undefined) {
  return (event: {
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
    });
}

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
- Every panel's query.sourceId MUST equal the provided sourceId.
- Keep result sets small; the server also enforces row limits.`;

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

function baseSystem(source: SourceRecord): string {
  return `You design monitoring dashboards as a strict JSON spec.
You NEVER return data rows — only a viz specification (SQL + layout).

The only authorized data source for this request:
sourceId: ${source.id}

Catalog (metadata only):
${buildCatalogPrompt(source)}

${SQL_RULES}

${DESCRIPTION_RULE}

Layout: a 12-column grid. By DEFAULT place two panels side by side (w=6 each)
and 4 rows tall (h=4), laid out left-to-right, top-to-bottom, without overlaps.
Use a wider or taller panel only when a request clearly calls for it. Choose viz
types from: line, area, bar,
scatter, stat, table, heatmap, pie, donut. Use 'area' for a filled time series
and 'scatter' for relationships between two numeric dimensions. Use
'pie'/'donut' for a proportional breakdown of a
small set of categories (one label column + one numeric value column; OMIT
'query.timeField' — these are not time-series). Use 'format'
(number|bytes|percent|ms) where meaningful.`;
}

export function streamDashboard(input: {
  source: SourceRecord;
  prompt: string;
  onFinish?: OnGenerationFinish;
}) {
  const { source, prompt, onFinish } = input;
  return streamObject({
    model: getModel(),
    onFinish: finish(onFinish),
    schema: Dashboard,
    schemaName: "Dashboard",
    schemaDescription: "A monitoring dashboard specification (viz spec, not data).",
    system: baseSystem(source),
    prompt: `Create a dashboard for this request:\n"""${prompt}"""\n
Use refreshIntervalMs=${config.defaultRefreshIntervalMs} and timeRange {from:"${config.defaultTimeFrom}", to:"${config.defaultTimeTo}"} unless the request clearly implies otherwise.`,
  });
}

/**
 * Ad-hoc exploration: generate a SINGLE panel spec that best answers a plain
 * natural-language question against the given source. Same invariants as every
 * other generation path — the model emits only a validated Panel (SQL + viz),
 * never data, and never a time filter (the server injects the range).
 */
export function streamExplorePanel(input: {
  source: SourceRecord;
  prompt: string;
  onFinish?: OnGenerationFinish;
}) {
  const { source, prompt, onFinish } = input;
  return streamObject({
    model: getModel(),
    onFinish: finish(onFinish),
    schema: Panel,
    schemaName: "Panel",
    schemaDescription: "A single panel specification (viz spec, not data).",
    system: baseSystem(source),
    prompt: `Answer this question with a SINGLE panel:
"""${prompt}"""

Return one Panel. Give it a concise title, use id "explore", and set layout to
{"x":0,"y":0,"w":12,"h":4}.

Viz selection (IMPORTANT — default to text/tabular output):
- Default to viz "table" and return the relevant rows/columns.
- Use "stat" only when the question asks for a single scalar value.
- Use a chart viz ("line", "area", "bar", "scatter", "heatmap", "pie", "donut") ONLY when the
  request explicitly asks to chart/plot/graph/visualize the data or to see a
  trend over time. Use "pie"/"donut" for share/proportion/breakdown questions
  across a small set of categories.`,
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
  onFinish?: OnGenerationFinish;
}) {
  const { prompt, grantedSecretRefs, onFinish } = input;
  const refRule =
    grantedSecretRefs.length > 0
      ? `'secretRef' MUST be one of: ${grantedSecretRefs.map((r) => JSON.stringify(r)).join(", ")}.
  Pick the one that best matches the description; do not invent another.`
      : `No 'secretRef' is granted to this workspace yet. Use "TS_METRICS"; the
  user will choose a granted one before creating the source.`;
  return streamObject({
    model: getModel(),
    onFinish: finish(onFinish),
    schema: SourceDraft,
    schemaName: "SourceDraft",
    schemaDescription:
      "A TimescaleDB/PostgreSQL data source registration: safe connection config plus a table catalog. Never contains credentials.",
    system: `You draft TimescaleDB/PostgreSQL data-source registrations for a
monitoring dashboard tool, from a plain-English description.

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
  the draft validates — the user will Refresh it against the live database.`,
    prompt: `Draft a data source for this description:\n"""${prompt}"""`,
  });
}

export function streamPanel(input: {
  source: SourceRecord;
  prompt: string;
  current: Panel;
  onFinish?: OnGenerationFinish;
}) {
  const { source, prompt, current, onFinish } = input;
  return streamObject({
    model: getModel(),
    onFinish: finish(onFinish),
    schema: Panel,
    schemaName: "Panel",
    schemaDescription: "A single dashboard panel specification (viz spec, not data).",
    system: baseSystem(source),
    prompt: `Here is the current panel spec:
${JSON.stringify(current, null, 2)}

Apply this change and return the full updated panel (keep the same "id"):
"""${prompt}"""`,
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
  source: SourceRecord;
  prompt: string;
  current: Dashboard;
  onFinish?: OnGenerationFinish;
}) {
  const { source, prompt, current, onFinish } = input;
  return streamObject({
    model: getModel(),
    onFinish: finish(onFinish),
    schema: Dashboard,
    schemaName: "Dashboard",
    schemaDescription: "A monitoring dashboard specification (viz spec, not data).",
    system: baseSystem(source),
    prompt: `Here is the current dashboard spec:
${JSON.stringify(current, null, 2)}

Apply this change and return the FULL updated dashboard:
"""${prompt}"""

Carry over every panel the request does not mention, unchanged and with the same
"id". Keep "title", "timeRange" and "refreshIntervalMs" unless the request asks
to change them.`,
  });
}
