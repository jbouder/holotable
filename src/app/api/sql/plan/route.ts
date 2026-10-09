import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { readJson, json, route } from "@/lib/http";
import { rowFilterFor, rowFilterHttpError } from "@/lib/row-scope";
import { getSourceById } from "@/lib/db/repo";
import { TimeRange } from "@/lib/ir";
import { panelQueryBody, panelQueryOf } from "@/lib/query-body";
import { QueryExecutionError } from "@/lib/sources/execution";
import type { SourcePlan } from "@/lib/sources/server/types";
import { VariableError } from "@/lib/sql/variables";
import { VariableValuesBody } from "@/lib/variable-selection";
import { resolveTimeRange } from "@/lib/time";
import { serverKind } from "@/lib/sources/server/registry";

export const runtime = "nodejs";

/** A panel's query in either language (#385): the path keeps its name. */
const Body = panelQueryBody({
  timeRange: TimeRange,
  /** The values the editor previews with (#67). */
  variables: VariableValuesBody.optional(),
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
  assertAuthorized(
    identity,
    "dashboard:generate",
    { workspaceId: source.workspaceId },
    { type: "source", id: source.id },
  );

  const kind = serverKind(source);
  const query = panelQueryOf(body);
  const variables = body.variables ?? {};
  const check = await kind.check(source, query, new Set(Object.keys(variables)));
  if (!check.ok)
    throw new HttpError(400, check.error ?? "invalid query", {}, "statement");

  const range = resolveTimeRange(body.timeRange);
  let plan: SourcePlan;
  try {
    plan = kind.plan(source, query, {
      from: range.from,
      to: range.to,
      // The plan shown is the one that would run for this caller (#31).
      rowFilter: rowFilterFor(source, identity),
      variables,
    });
  } catch (err) {
    if (err instanceof VariableError || err instanceof QueryExecutionError)
      throw new HttpError(400, err.message, {}, "statement");
    throw rowFilterHttpError(err);
  }

  return json(kind.planView({ source, query, plan, timeRange: body.timeRange }));
});
