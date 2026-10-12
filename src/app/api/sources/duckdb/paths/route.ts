import { assertAuthorized, HttpError, requireIdentity } from "@/lib/auth/authorize";
import { json, route } from "@/lib/http";
import { MemoryRateLimitStore } from "@/lib/limits/rate";
import { duckdbPathMenu } from "@/lib/sources/server/registry";

export const runtime = "nodejs";

/**
 * The ceiling on listings, per user per workspace: the DuckDB form asks once
 * when it opens. A constant, like `/api/secret-refs`'s, not a capacity knob.
 */
const RATE_PER_MINUTE = 60;

const rateStore = new MemoryRateLimitStore();

/**
 * What a DuckDB source may name (#573): the directories and `.duckdb` files
 * directly under `DUCKDB_SOURCES_DIR`, for the form's path picker.
 *
 * Like `/api/secret-refs`, it is a menu for the person about to create a
 * source and nothing more:
 *
 * - gated on `source:manage` in a named workspace, the role that may create
 *   a source naming one of these paths;
 * - names only, one level deep, never an absolute path: the answer is
 *   `{ ok: true, paths: [{ name, layout }] }`, or `{ ok: false, error }` with
 *   a message that names the variable when the root is unset or unreadable;
 * - rate limited per caller, and not audited, as reading the granted refs is
 *   not: it changes nothing and connects to nothing. Discovering a path's
 *   tables, which opens it, is audited (`source.discover`).
 */
export const GET = route("sources.duckdb.paths", async (req: Request) => {
  const identity = await requireIdentity();
  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  if (!workspaceId) throw new HttpError(400, "workspaceId is required");

  assertAuthorized(identity, "source:manage", { workspaceId });

  const decision = await rateStore.take(
    `${workspaceId}\u0000${identity.sub}`,
    { perMinute: RATE_PER_MINUTE },
    Date.now(),
  );
  if (!decision.allowed) {
    const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
    throw new HttpError(
      429,
      `too many path listings: ${RATE_PER_MINUTE} per minute per user in this workspace; retry after ${seconds}s`,
      { "Retry-After": String(seconds) },
    );
  }

  return json(await duckdbPathMenu(), { headers: { "cache-control": "no-store" } });
});
