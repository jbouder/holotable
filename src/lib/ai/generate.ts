import { streamObject } from "ai";
import { getModel } from "@/lib/ai/provider";
import { buildCatalogPrompt } from "@/lib/timescaledb/catalog";
import { Dashboard, Panel } from "@/lib/ir";
import { config } from "@/lib/config";
import { SourceDraft, type SourceRecord } from "@/lib/registry";

/**
 * LLM generation.
 *
 * The model runs EXACTLY ONCE per author action (create / full edit / single
 * panel NL edit) and only ever emits a validated spec conforming to the shared
 * Zod IR — never data. The prompt contains catalog METADATA for the single
 * selected, already-authorized source. The model must not write time filters;
 * the server injects the dashboard time range at execution.
 */

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

function baseSystem(source: SourceRecord): string {
  return `You design monitoring dashboards as a strict JSON spec.
You NEVER return data rows — only a viz specification (SQL + layout).

The only authorized data source for this request:
sourceId: ${source.id}

Catalog (metadata only):
${buildCatalogPrompt(source)}

${SQL_RULES}

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

export function streamDashboard(input: { source: SourceRecord; prompt: string }) {
  const { source, prompt } = input;
  return streamObject({
    model: getModel(),
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
}) {
  const { source, prompt } = input;
  return streamObject({
    model: getModel(),
    schema: Panel,
    schemaName: "Panel",
    schemaDescription: "A single panel specification (viz spec, not data).",
    system: baseSystem(source),
    prompt: `Answer this question with a SINGLE panel:
"""${prompt}"""

Return one Panel. Give it a concise title, a one-sentence "description" of WHAT
the query computes (describe intent only — never invent result values), use id
"explore", and set layout to {"x":0,"y":0,"w":12,"h":4}.

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
 */
export function streamSourceDraft(input: { prompt: string }) {
  const { prompt } = input;
  return streamObject({
    model: getModel(),
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
  resolved at runtime from an environment variable family named by 'secretRef'.
  Choose a sensible UPPER_SNAKE 'secretRef' (e.g. "TS_METRICS"); do not invent
  any credential value.
- If the description contains a password or secret, ignore it entirely.

Field rules:
- 'id': lowercase slug, e.g. "ts-metrics". Derive it from the name/purpose.
- 'name': a short human-readable label.
- 'config.host'/'config.port'/'config.database': from the description; default
  port to 5432 and, when unstated, use a clearly-placeholder host the user will
  correct. 'config.schema' defaults to "public"; 'config.ssl' defaults to false.
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
}) {
  const { source, prompt, current } = input;
  return streamObject({
    model: getModel(),
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
