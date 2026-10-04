import { z } from "zod";
import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { readJson, json, route } from "@/lib/http";
import { audit } from "@/lib/audit";
import { getSourceById } from "@/lib/db/repo";
import { validateSql, buildExecutablePlan } from "@/lib/sql/safety";
import { resolveTimeRange } from "@/lib/time";
import { executePlan, QueryExecutionError } from "@/lib/timescaledb/client";
import { TimeRange } from "@/lib/ir";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({
  sourceId: z.string().min(1),
  sql: z.string().min(1).max(8000),
  timeField: z.string().min(1).max(128).optional(),
  timeRange: TimeRange,
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

    const check = await validateSql(body.sql, source.config);
    if (!check.ok) {
      record("failure", "validate");
      throw new HttpError(400, check.error ?? "invalid sql");
    }

    const range = resolveTimeRange(body.timeRange);
    let result: Awaited<ReturnType<typeof executePlan>>;
    try {
      const plan = buildExecutablePlan({
        sql: body.sql,
        timeField: body.timeField,
        from: range.from,
        to: range.to,
      });
      result = await executePlan(source, plan);
    } catch (err) {
      record("failure", "execute");
      throw err;
    }
    record("success");
    return json(result);
  } catch (err) {
    // A failed statement is the user's query to fix — surface it as a 400 with
    // the real message, tagged `statement` so the client offers an edit-and-
    // retry rather than the generic "correct the highlighted value".
    if (err instanceof QueryExecutionError) {
      throw new HttpError(400, err.message, {}, "statement");
    }
    // Everything else is `route()`'s to classify, log, and answer.
    throw err;
  }
});
