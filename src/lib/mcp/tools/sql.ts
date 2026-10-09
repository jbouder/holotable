import { z } from "zod";
import { audit } from "@/lib/audit";
import { assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { config } from "@/lib/config";
import { TimeRange, VariableName } from "@/lib/ir";
import { defineTool, type McpTool, READ_ONLY } from "@/lib/mcp/tool";
import type { McpDeps } from "@/lib/mcp/tools/deps";
import { liveSource } from "@/lib/mcp/tools/sources";
import { rowFilterFor, rowFilterHttpError } from "@/lib/row-scope";
import { VariableError } from "@/lib/sql/variables";
import { resolveTimeRange } from "@/lib/time";
import { QueryExecutionError } from "@/lib/sources/execution";
import { serverKind } from "@/lib/sources/server/registry";
import { VariableValuesBody } from "@/lib/variable-selection";

/**
 * The guard and the executor, for an agent iterating on a statement.
 * `validate_sql` is `POST /api/sql/validate`; `run_query` is `POST /api/query`
 * with the same gate (editor, because a rejection message names catalog
 * details), the same guard, the same server-resolved time window and the
 * same row, byte and time limits, and the same `query.execute` audit row per
 * statement. The one addition is a cap on the rows handed back to the model,
 * as the dashboard chat's tool has: a result is for reasoning about, and a
 * panel's query should aggregate rather than page.
 */

/** Rows handed back to the model, whatever the statement returned. */
export const MAX_TOOL_ROWS = 200;

const Sql = z
  .string()
  .min(1)
  .max(8000)
  .describe("One SELECT or WITH statement, following the SQL rules.");

export function sqlTools(deps: McpDeps): McpTool[] {
  return [
    defineTool({
      name: "validate_sql",
      title: "Validate SQL against the guard",
      description:
        "Run a statement through the SQL guard against one source's catalog without executing it: one SELECT built from allowed constructs, only that source's tables and columns, no denied functions. Returns ok, or the exact error the server would give, so a query can be fixed before it is run or put in a panel.",
      input: z.object({
        sourceId: z.string().min(1),
        sql: Sql,
        variables: z
          .array(VariableName)
          .max(10)
          .optional()
          .describe("Dashboard variables the statement may reference as :name."),
      }),
      output: z.object({ ok: z.boolean(), error: z.string().optional() }),
      annotations: READ_ONLY,
      async run(args, { identity }) {
        const source = await liveSource(deps, args.sourceId);
        assertAuthorized(
          identity,
          "dashboard:generate",
          { workspaceId: source.workspaceId },
          { type: "source", id: source.id },
        );
        // SQL until the tools learn PromQL (#389); a Prometheus source
        // refuses it by name.
        const check = await serverKind(source).check(
          source,
          { sourceId: source.id, sql: args.sql },
          new Set(args.variables ?? []),
        );
        return check.ok ? { ok: true } : { ok: false, error: check.error ?? "rejected" };
      },
    }),

    defineTool({
      name: "run_query",
      title: "Run a query",
      description: `Execute one guarded SELECT against a source and return the rows, read-only, with the server's row, size and time limits. The server resolves the time range (relative expressions such as now-6h) and, when timeField names the statement's time column, injects the window; do not add a time filter yourself. At most ${MAX_TOOL_ROWS} rows come back; aggregate rather than page.`,
      input: z.object({
        sourceId: z.string().min(1),
        sql: Sql,
        timeField: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe(
            "The output column that carries time, for the window to be applied to.",
          ),
        timeRange: TimeRange.optional().describe(
          `The window, as relative expressions or ISO instants; the server's default (${config.defaultTimeFrom} .. ${config.defaultTimeTo}) when omitted.`,
        ),
        variables: VariableValuesBody.optional().describe("Values for :name references."),
      }),
      output: z.object({
        columns: z.array(z.string()),
        rows: z.array(z.record(z.string(), z.unknown())),
        rowCount: z.int(),
        truncated: z.boolean(),
        window: z.object({ from: z.string(), to: z.string() }),
      }),
      annotations: READ_ONLY,
      async run(args, { identity }) {
        const source = await liveSource(deps, args.sourceId);
        assertAuthorized(
          identity,
          "dashboard:generate",
          { workspaceId: source.workspaceId },
          { type: "source", id: source.id },
        );
        // One audit row per statement someone asked to run (#30), whichever
        // way it went: refused by the guard, failed on the source, or ran.
        const record = (outcome: "success" | "failure", stage?: string) =>
          audit({
            actor: identity,
            action: "query.execute",
            workspaceId: source.workspaceId,
            resource: { type: "source", id: source.id },
            outcome,
            detail: { via: "mcp", sql: args.sql, stage },
          });

        const variables = args.variables ?? {};
        const query = {
          sourceId: source.id,
          sql: args.sql,
          ...(args.timeField ? { timeField: args.timeField } : {}),
        };
        const check = await serverKind(source).check(
          source,
          query,
          new Set(Object.keys(variables)),
        );
        if (!check.ok) {
          record("failure", "validate");
          throw new HttpError(400, check.error ?? "rejected");
        }
        const { from, to } = resolveTimeRange(
          args.timeRange ?? { from: config.defaultTimeFrom, to: config.defaultTimeTo },
        );
        try {
          const plan = serverKind(source).plan(source, query, {
            from,
            to,
            rowFilter: rowFilterFor(source, identity),
            variables,
          });
          const result = await deps.executePlan(source, plan);
          record("success");
          return {
            columns: result.columns,
            rows: result.rows.slice(0, MAX_TOOL_ROWS),
            rowCount: result.rows.length,
            truncated: result.rows.length > MAX_TOOL_ROWS,
            window: { from: from.toISOString(), to: to.toISOString() },
          };
        } catch (err) {
          record("failure", "execute");
          if (err instanceof QueryExecutionError || err instanceof VariableError)
            throw err;
          throw rowFilterHttpError(err);
        }
      },
    }),
  ];
}
