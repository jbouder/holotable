import { z } from "zod";
import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { readJson, json, route } from "@/lib/http";
import { getSourceById } from "@/lib/db/repo";
import { validateSql } from "@/lib/sql/safety";

export const runtime = "nodejs";

const Body = z.object({
  sourceId: z.string().min(1),
  sql: z.string().min(1).max(8000),
});

/**
 * Check a statement against a source's catalog without executing it.
 *
 * This is the same `validateSql` call `resolveAndValidateDashboard` makes on
 * save and `/api/query` makes before execution, so the answer an author gets
 * here is the answer they will get there — the guard is not re-implemented and
 * cannot drift. Nothing is planned, nothing connects to the database, and
 * nothing is written.
 *
 * A rejected statement is a `200` carrying `{ ok: false, error }`: the request
 * itself succeeded, and the verdict is the payload. The `4xx` codes stay for
 * requests that could not be answered at all.
 *
 * Authorization is `/api/query`'s, deliberately: knowing which tables a source
 * allowlists is the same disclosure either way, so a caller who may not preview
 * a query may not probe its catalog either.
 */
export const POST = route("sql.validate", async (req: Request) => {
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
  return json(
    check.ok ? { ok: true } : { ok: false, error: check.error ?? "invalid sql" },
  );
});
