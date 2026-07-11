import { z } from "zod";
import {
  requireIdentity,
  assertAuthorized,
  errorResponse,
  HttpError,
} from "@/lib/auth/authorize";
import { readJson, json } from "@/lib/http";
import { getSourceById } from "@/lib/db/repo";
import { validateSql, buildExecutablePlan } from "@/lib/sql/safety";
import { resolveTimeRange } from "@/lib/time";
import { executePlan } from "@/lib/timescaledb/client";
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
export async function POST(req: Request) {
  try {
    const identity = await requireIdentity();
    const body = await readJson(req, Body);

    const source = await getSourceById(body.sourceId);
    if (!source || source.tombstonedAt) {
      throw new HttpError(400, "unknown or removed source");
    }
    assertAuthorized(identity, "dashboard:generate", {
      workspaceId: source.workspaceId,
    });

    const check = validateSql(body.sql, source.config);
    if (!check.ok) throw new HttpError(400, check.error ?? "invalid sql");

    const range = resolveTimeRange(body.timeRange);
    const plan = buildExecutablePlan({
      sql: body.sql,
      timeField: body.timeField,
      from: range.from,
      to: range.to,
    });
    const result = await executePlan(source, plan);
    return json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
