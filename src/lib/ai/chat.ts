import { streamText, tool, convertToModelMessages, stepCountIs, type UIMessage } from "ai";
import { z } from "zod";
import { getModel } from "@/lib/ai/provider";
import { buildCatalogPrompt } from "@/lib/timescaledb/catalog";
import { SQL_RULES } from "@/lib/ai/generate";
import { validateSql, buildExecutablePlan, type ExecutablePlan } from "@/lib/sql/safety";
import { resolveTimeRange } from "@/lib/time";
import { executePlan, QueryExecutionError } from "@/lib/timescaledb/client";
import type { Dashboard } from "@/lib/ir";
import type { SourceRecord } from "@/lib/registry";

/**
 * Dashboard chat.
 *
 * A read-only conversational assistant scoped to a SINGLE dashboard. It reasons
 * over the dashboard's panel specs first and may escalate to fetching FRESH
 * data via a guarded `runQuery` tool. Every invariant of the rest of the app is
 * preserved:
 *   - the model NEVER returns rendered data — the tool executes SELECTs through
 *     the same validateSql -> buildExecutablePlan -> executePlan pipeline;
 *   - the SERVER owns the time window (the dashboard's own timeRange is injected,
 *     the model cannot supply time filters);
 *   - sources are referenced only by the opaque ids already on the dashboard and
 *     re-resolved server-side — no connection details or credentials are exposed;
 *   - the chat cannot mutate the dashboard.
 */

/** Cap on rows handed back to the model, to bound context/token cost. */
export const MAX_TOOL_ROWS = 200;

/** How many model<->tool steps a single turn may take. */
const MAX_STEPS = 6;

type ChatQueryArgs = {
  sourceId: string;
  sql: string;
  timeField?: string;
};

export type ChatQueryPlan =
  | { ok: true; source: SourceRecord; plan: ExecutablePlan }
  | { ok: false; error: string };

/**
 * Pure guard for a model-proposed query. Restricts the query to a source that
 * is actually referenced by (and authorized for) this dashboard, validates the
 * untrusted SQL, and injects the dashboard's server-owned time range. Does NOT
 * touch the database — the caller runs the returned plan. Exported for testing.
 */
export function buildChatQueryPlan(input: {
  dashboard: Dashboard;
  sources: SourceRecord[];
  args: ChatQueryArgs;
}): ChatQueryPlan {
  const { dashboard, sources, args } = input;

  const source = sources.find((s) => s.id === args.sourceId);
  if (!source) {
    return {
      ok: false,
      error: `source "${args.sourceId}" is not available on this dashboard. Use one of: ${sources
        .map((s) => s.id)
        .join(", ")}.`,
    };
  }

  const check = validateSql(args.sql, source.config);
  if (!check.ok) return { ok: false, error: check.error ?? "invalid sql" };

  // The server is the sole authority on the window: use the dashboard's own
  // range, never anything the model tried to express.
  const range = resolveTimeRange(dashboard.timeRange);
  try {
    const plan = buildExecutablePlan({
      sql: args.sql,
      timeField: args.timeField,
      from: range.from,
      to: range.to,
    });
    return { ok: true, source, plan };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "invalid query" };
  }
}

function buildSystemPrompt(dashboard: Dashboard, sources: SourceRecord[]): string {
  const panels = dashboard.panels
    .map((p) => {
      const lines = [
        `- panel "${p.id}" — ${p.title} (viz: ${p.viz}, source: ${p.query.sourceId})`,
      ];
      if (p.description) lines.push(`    intent: ${p.description}`);
      if (p.query.timeField) lines.push(`    timeField: ${p.query.timeField}`);
      lines.push(`    sql: ${p.query.sql}`);
      return lines.join("\n");
    })
    .join("\n");

  const catalogs = sources.length
    ? sources.map((s) => buildCatalogPrompt(s)).join("\n\n")
    : "(no queryable sources are available to you on this dashboard)";

  return `You are a data assistant embedded in a live monitoring dashboard. You help the
user understand THIS dashboard and the data behind it. You are READ-ONLY: you
answer questions and explain data, but you cannot modify the dashboard, add
panels, or change its settings.

Dashboard: "${dashboard.title}"
Time range (fixed by the server): ${dashboard.timeRange.from} -> ${dashboard.timeRange.to}
Refresh interval: ${dashboard.refreshIntervalMs}ms

Panels on this dashboard:
${panels}

How to answer:
- First reason from the panel specs above. If the user's question is about what a
  panel shows, how it is computed, or how panels relate, answer directly.
- When the user needs an actual value, trend, or breakdown that is not already
  evident, call the "runQuery" tool to fetch fresh data, then answer from the
  returned rows.
- NEVER invent, guess, or fabricate metric values. If you have not queried a
  number, do not state it. If a query fails or returns nothing, say so plainly.
- Be concise. Prefer short, direct answers with concrete figures over prose.

Using runQuery:
- 'sourceId' MUST be one of the dashboard's source ids listed above.
- The server automatically restricts results to the dashboard's time range; do
  NOT write any time filter yourself.
- Follow these SQL rules exactly:
${SQL_RULES}

Queryable source catalogs (metadata only — never the underlying data):
${catalogs}`;
}

/**
 * Run one chat turn. Returns the streaming result; the route serializes it with
 * `.toUIMessageStreamResponse()`.
 */
export async function streamDashboardChat(input: {
  dashboard: Dashboard;
  sources: SourceRecord[];
  messages: UIMessage[];
}) {
  const { dashboard, sources, messages } = input;
  const modelMessages = await convertToModelMessages(messages);

  return streamText({
    model: getModel(),
    system: buildSystemPrompt(dashboard, sources),
    messages: modelMessages,
    stopWhen: stepCountIs(MAX_STEPS),
    tools: {
      runQuery: tool({
        description:
          "Run a read-only SQL SELECT against one of this dashboard's data sources to fetch fresh data. The server injects the dashboard's time range automatically; do not add a time filter. Returns columns and rows.",
        inputSchema: z.object({
          sourceId: z
            .string()
            .describe("One of the dashboard's source ids (see the panel list)."),
          sql: z
            .string()
            .max(8000)
            .describe("A single SELECT/WITH statement following the SQL rules."),
          timeField: z
            .string()
            .max(128)
            .optional()
            .describe(
              "Output alias of the time column, when the result is time-series. Omit for scalars/breakdowns.",
            ),
        }),
        execute: async (args) => {
          const built = buildChatQueryPlan({ dashboard, sources, args });
          if (!built.ok) return { error: built.error };
          try {
            const result = await executePlan(built.source, built.plan);
            return {
              columns: result.columns,
              rows: result.rows.slice(0, MAX_TOOL_ROWS),
              rowCount: result.rows.length,
              truncated: result.rows.length > MAX_TOOL_ROWS,
            };
          } catch (err) {
            // Statement-level errors are the query's fault and safe to surface so
            // the model can correct itself; anything else is infra — log it and
            // return a generic message rather than leaking internals.
            if (err instanceof QueryExecutionError) return { error: err.message };
            console.error("dashboard chat runQuery failed:", err);
            return { error: "query execution failed" };
          }
        },
      }),
    },
  });
}
