import { z } from "zod";
import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { readJson, json, route } from "@/lib/http";
import { config } from "@/lib/config";
import { getSourceById } from "@/lib/db/repo";
import { TimeRange } from "@/lib/ir";
import { buildQueryPlanView } from "@/lib/query-plan";
import { validateSql, buildExecutablePlan } from "@/lib/sql/safety";
import { resolveTimeRange } from "@/lib/time";
import { sessionStatements } from "@/lib/timescaledb/client";

export const runtime = "nodejs";

const Body = z.object({
  sourceId: z.string().min(1),
  sql: z.string().min(1).max(8000),
  timeField: z.string().min(1).max(128).optional(),
  timeRange: TimeRange,
});

/**
 * Describe what the database would be asked, without asking it.
 *
 * This is `/api/query` with the execution removed: the same `validateSql`, the
 * same `resolveTimeRange`, the same `buildExecutablePlan`, the same
 * `sessionStatements`. Re-deriving any of them here would let the explanation
 * drift from the behaviour it explains, which is the one thing this route must
 * not do. Nothing connects to the source's database and nothing is written.
 *
 * Authorization is `/api/sql/validate`'s, for the same reason: the body
 * carries arbitrary SQL, and the guard's rejection message names the table or
 * function it refused — so answering is the same catalog disclosure that
 * previewing a query is, and is gated on the same permission.
 *
 * A statement the guard refuses is a `400` with the guard's message. Unlike
 * validate, there is no `{ok:false}` verdict to return: a refused statement
 * has no plan, because it never reaches one.
 */
export const POST = route("sql.plan", async (req: Request) => {
  const identity = await requireIdentity();
  const body = await readJson(req, Body);

  const source = await getSourceById(body.sourceId);
  if (!source || source.tombstonedAt) {
    throw new HttpError(400, "unknown or removed source");
  }
  assertAuthorized(identity, "dashboard:generate", {
    workspaceId: source.workspaceId,
  });

  const check = await validateSql(body.sql, source.config);
  if (!check.ok) throw new HttpError(400, check.error ?? "invalid sql", {}, "statement");

  const range = resolveTimeRange(body.timeRange);
  const plan = buildExecutablePlan({
    sql: body.sql,
    timeField: body.timeField,
    from: range.from,
    to: range.to,
  });

  return json(
    buildQueryPlanView({
      sql: body.sql,
      timeField: body.timeField,
      timeRange: body.timeRange,
      plan,
      session: sessionStatements(source.config.schema),
      limits: {
        maxRows: config.maxQueryRows,
        statementTimeoutMs: config.queryTimeoutSeconds * 1000,
        maxResultBytes: config.maxResultBytes,
      },
    }),
  );
});
