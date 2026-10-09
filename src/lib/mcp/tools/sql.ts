import { z } from "zod";
import { audit } from "@/lib/audit";
import { assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { config } from "@/lib/config";
import {
  Duration,
  type PanelQuery,
  queryStatement,
  TimeRange,
  VariableName,
} from "@/lib/ir";
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

/**
 * The query, in its source's language (#389). The tools keep their names,
 * `validate_sql` included, because a rename breaks every client's config;
 * which field to send is the source's kind's to say, and `list_sources` and
 * `describe_source` say it.
 */
const Statement = {
  sql: z
    .string()
    .min(1)
    .max(8000)
    .optional()
    .describe(
      "For a SQL source (kind timescaledb): one SELECT or WITH statement, following the SQL rules. Send exactly one of sql and promql.",
    ),
  promql: z
    .string()
    .min(1)
    .max(8000)
    .optional()
    .describe(
      "For a Prometheus source (kind prometheus): one PromQL expression over the source's listed metrics, with no @ modifier and no time of its own. Send exactly one of sql and promql.",
    ),
};

const EvaluatedAs = {
  instant: z
    .boolean()
    .optional()
    .describe(
      "PromQL only: one sample per series at the window's end, as a stat, gauge, pie or table draws it, instead of a range.",
    ),
  minStep: Duration.optional().describe(
    "PromQL only: a floor on the step, such as 1m. The server picks the step and only ever raises it to this.",
  ),
};

/** Exactly one language, and the PromQL options only with PromQL. */
function oneLanguage<T extends z.ZodObject>(schema: T) {
  return schema.superRefine((value, ctx) => {
    const v = value as {
      sql?: string;
      promql?: string;
      instant?: boolean;
      minStep?: string;
    };
    if ((v.sql === undefined) === (v.promql === undefined)) {
      ctx.addIssue({ code: "custom", message: "send exactly one of sql and promql" });
    }
    if (v.sql !== undefined && (v.instant !== undefined || v.minStep !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "instant and minStep are for promql only",
      });
    }
    if ("timeField" in v && v.timeField !== undefined && v.promql !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "timeField is for sql only; a PromQL range is always keyed by time",
      });
    }
  }) as unknown as z.ZodType<z.output<T>>;
}

/** The panel query the arguments describe, by its fields, never spread. */
function queryOf(
  sourceId: string,
  args: {
    sql?: string;
    promql?: string;
    instant?: boolean;
    minStep?: string;
    timeField?: string;
  },
): PanelQuery {
  if (args.promql !== undefined) {
    return {
      sourceId,
      promql: args.promql,
      ...(args.instant !== undefined ? { instant: args.instant } : {}),
      ...(args.minStep !== undefined ? { minStep: args.minStep } : {}),
    };
  }
  return {
    sourceId,
    sql: args.sql ?? "",
    ...(args.timeField ? { timeField: args.timeField } : {}),
  };
}

export function sqlTools(deps: McpDeps): McpTool[] {
  return [
    defineTool({
      name: "validate_sql",
      title: "Validate a query against the guard",
      description:
        "Run a query through its source's guard without executing it. SQL (sql, for a timescaledb source): one SELECT built from allowed constructs, only that source's tables and columns, no denied functions. PromQL (promql, for a prometheus source): one expression over the listed metrics, nothing that names a time of its own. Returns ok, with the guard's hints for PromQL (an unlisted label, rate() over a gauge, a counter drawn raw), or the exact error the server would give, so a query can be fixed before it is run or put in a panel. A query in the wrong language for its source is refused by name.",
      input: z.object({
        sourceId: z.string().min(1),
        ...Statement,
        ...EvaluatedAs,
        variables: z
          .array(VariableName)
          .max(10)
          .optional()
          .describe(
            'Dashboard variables the query may reference: :name in SQL, a matcher value ":name" in PromQL.',
          ),
      }),
      output: z.object({
        ok: z.boolean(),
        error: z.string().optional(),
        hints: z.array(z.string()).optional(),
      }),
      parse: oneLanguage(
        z.object({
          sourceId: z.string().min(1),
          ...Statement,
          ...EvaluatedAs,
          variables: z.array(VariableName).max(10).optional(),
        }),
      ),
      annotations: READ_ONLY,
      async run(args, { identity }) {
        const source = await liveSource(deps, args.sourceId);
        assertAuthorized(
          identity,
          "dashboard:generate",
          { workspaceId: source.workspaceId },
          { type: "source", id: source.id },
        );
        // The source's kind checks it; a query in the other language is
        // refused by name (#389).
        const check = await serverKind(source).check(
          source,
          queryOf(source.id, args),
          new Set(args.variables ?? []),
        );
        if (!check.ok) return { ok: false, error: check.error ?? "rejected" };
        return check.hints?.length ? { ok: true, hints: check.hints } : { ok: true };
      },
    }),

    defineTool({
      name: "run_query",
      title: "Run a query",
      description: `Execute one guarded query against a source and return the rows, read-only, with the server's limits: a SELECT (sql) for a timescaledb source, a PromQL expression (promql) for a prometheus source. The server resolves the time range (relative expressions such as now-6h). For SQL, when timeField names the statement's time column, it injects the window; for PromQL it picks start, end and step itself, and a range answers a time column plus one column per series (an instant query: one row per series, a column per label, then value). Do not add a time filter yourself. At most ${MAX_TOOL_ROWS} rows come back; aggregate rather than page.`,
      input: z.object({
        sourceId: z.string().min(1),
        ...Statement,
        ...EvaluatedAs,
        timeField: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe(
            "SQL only: the output column that carries time, for the window to be applied to.",
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
      parse: oneLanguage(
        z.object({
          sourceId: z.string().min(1),
          ...Statement,
          ...EvaluatedAs,
          timeField: z.string().min(1).max(128).optional(),
          timeRange: TimeRange.optional(),
          variables: VariableValuesBody.optional(),
        }),
      ),
      annotations: READ_ONLY,
      async run(args, { identity }) {
        const source = await liveSource(deps, args.sourceId);
        assertAuthorized(
          identity,
          "dashboard:generate",
          { workspaceId: source.workspaceId },
          { type: "source", id: source.id },
        );
        const query = queryOf(source.id, args);
        // One audit row per statement someone asked to run (#30), whichever
        // way it went: refused by the guard, failed on the source, or ran.
        const record = (outcome: "success" | "failure", stage?: string) =>
          audit({
            actor: identity,
            action: "query.execute",
            workspaceId: source.workspaceId,
            resource: { type: "source", id: source.id },
            outcome,
            detail: { via: "mcp", ...queryStatement(query), stage },
          });

        const variables = args.variables ?? {};
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
