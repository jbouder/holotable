import { streamObject } from "ai";
import { getModel } from "@/lib/ai/provider";
import { buildCatalogPrompt } from "@/lib/timescaledb/catalog";
import { Dashboard, Panel } from "@/lib/ir";
import { config } from "@/lib/config";
import type { SourceRecord } from "@/lib/registry";

/**
 * LLM generation.
 *
 * The model runs EXACTLY ONCE per author action (create / full edit / single
 * panel NL edit) and only ever emits a validated spec conforming to the shared
 * Zod IR — never data. The prompt contains catalog METADATA for the single
 * selected, already-authorized source. The model must not write time filters;
 * the server injects the dashboard time range at execution.
 */

const SQL_RULES = `SQL rules (STRICT):
- Emit TimescaleDB/PostgreSQL SELECT statements only. No INSERT/UPDATE/DDL, no semicolons, no comments.
- Reference ONLY tables listed in the catalog for the given source.
- Do NOT add any time filter, now()/today(), or WHERE on the time column: the
  server injects the dashboard time range automatically on 'query.timeField'.
- For time-series (line/bar/heatmap), group by a time bucket aliased to a column
  and set that column as 'query.timeField'. Always ORDER BY the time column ASC.
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

Layout: a 12-column grid. Give each panel a sensible {x,y,w,h}. Choose viz types
from: line, bar, stat, table, heatmap. Use 'format' (number|bytes|percent|ms)
where meaningful.`;
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
