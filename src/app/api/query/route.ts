import { z } from "zod";
import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { readJson, json, route } from "@/lib/http";
import { audit } from "@/lib/audit";
import { getSourceById } from "@/lib/db/repo";
import { resolveTimeRange } from "@/lib/time";
import { rowFilterFor, rowFilterHttpError } from "@/lib/row-scope";
import { QueryExecutionError, type QueryResult } from "@/lib/sources/execution";
import { serverKind } from "@/lib/sources/server/registry";
import { TimeRange } from "@/lib/ir";
import { VariableError } from "@/lib/sql/variables";
import { VariableValuesBody } from "@/lib/variable-selection";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({
  sourceId: z.string().min(1),
  sql: z.string().min(1).max(8000),
  timeField: z.string().min(1).max(128).optional(),
  timeRange: TimeRange,
  /** The dashboard's variables as the editor previews them (#67). */
  variables: VariableValuesBody.optional(),
});

/**
 * Execute a single guarded query (used by preview during author/edit).
 * Authorization: editor on the trusted source's workspace. The SQL is fully
 * validated and the server injects the time range; the model never controls it.
 */
export const POST = route("query", async (req: Request) => {
  try {
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

    // One audit row per statement someone asked to run (#30), whichever way
    // it went: refused by the guard, failed on the source, or ran.
    const record = (outcome: "success" | "failure", stage?: string) =>
      audit({
        actor: identity,
        action: "query.execute",
        workspaceId: source.workspaceId,
        resource: { type: "source", id: source.id },
        outcome,
        detail: { via: "preview", sql: body.sql, stage },
      });

    const kind = serverKind(source);
    const variables = body.variables ?? {};
    const check = await kind.validate(
      body.sql,
      source.config,
      new Set(Object.keys(variables)),
    );
    if (!check.ok) {
      record("failure", "validate");
      throw new HttpError(400, check.error ?? "invalid sql");
    }

    const range = resolveTimeRange(body.timeRange);
    let result: QueryResult;
    try {
      const plan = kind.plan({
        sql: body.sql,
        timeField: body.timeField,
        from: range.from,
        to: range.to,
        // The caller's own rows, when the source filters them (#31).
        rowFilter: rowFilterFor(source, identity),
        variables,
      });
      result = await kind.execute(source, plan);
    } catch (err) {
      record("failure", "execute");
      throw err;
    }
    record("success");
    // The window the rows were selected over, as resolved here: a chart that
    // runs to "now" ends at it rather than at the browser's clock (#201).
    return json({
      ...result,
      window: { from: range.from.getTime(), to: range.to.getTime() },
    });
  } catch (err) {
    // A failed statement is the user's query to fix — surface it as a 400 with
    // the real message, tagged `statement` so the client offers an edit-and-
    // retry rather than the generic "correct the highlighted value".
    if (err instanceof QueryExecutionError || err instanceof VariableError) {
      throw new HttpError(400, err.message, {}, "statement");
    }
    // A statement the row filter cannot narrow is the author's to fix too.
    const mapped = rowFilterHttpError(err);
    if (mapped !== err) throw mapped;
    // Everything else is `route()`'s to classify, log, and answer.
    throw err;
  }
});
