import { assertAuthorized, HttpError, requireIdentity } from "@/lib/auth/authorize";
import { audit } from "@/lib/audit";
import { json, route } from "@/lib/http";
import { MemoryRateLimitStore } from "@/lib/limits/rate";
import { duckdbUpload } from "@/lib/sources/server/registry";

export const runtime = "nodejs";
// A large file on a slow link takes a while; the byte cap bounds it.
export const maxDuration = 300;

/**
 * The ceiling on uploads, per user per workspace. A constant, like the path
 * route's, not a capacity knob: an upload is a person choosing files.
 */
const RATE_PER_MINUTE = 10;

const rateStore = new MemoryRateLimitStore();

/**
 * Upload CSV or JSON files as a DuckDB source (#595, #596), with no access to the server's
 * file system: `?workspaceId=` and a `multipart/form-data` body of `files`.
 *
 * - gated on `source:manage` in the named workspace, the role that may then
 *   create a source over what was uploaded, and rate limited per caller;
 * - streamed to `DUCKDB_SOURCES_DIR/uploads/<workspaceId>/<fresh id>/`, one
 *   `<name>.csv` (or `.json`, `.jsonl`, `.ndjson`) per file, never held
 *   whole in memory, under
 *   `DUCKDB_UPLOAD_MAX_BYTES` per file and `DUCKDB_UPLOAD_MAX_FILES` files;
 * - all or nothing: a refused or cancelled upload leaves no file behind;
 * - answered `{ ok: true, path, files: [{ name, bytes }] }`, the relative path
 *   the source then stores, or `{ ok: false, error, file? }` with a message
 *   that names the variable or the person's own file, never a server path;
 * - audited as `source.upload`, success or failure, with the file count and
 *   sizes and never a path or a file's contents.
 *
 * Creating the source is still `POST /api/sources`, whose save check holds a
 * path under `uploads/` to the source's own workspace.
 */
export const POST = route("sources.duckdb.uploads", async (req: Request) => {
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
      `too many uploads: ${RATE_PER_MINUTE} per minute per user in this workspace; retry after ${seconds}s`,
      { "Retry-After": String(seconds) },
    );
  }

  const length = Number(req.headers.get("content-length"));
  const result = await duckdbUpload({
    workspaceId,
    contentType: req.headers.get("content-type"),
    contentLength: Number.isFinite(length) && length > 0 ? length : null,
    body: req.body,
  });
  if (result.ok) {
    audit({
      actor: identity,
      action: "source.upload",
      workspaceId,
      detail: {
        files: result.files.length,
        bytes: result.files.reduce((sum, f) => sum + f.bytes, 0),
      },
    });
    return json(
      { ok: true, path: result.path, files: result.files },
      { headers: { "cache-control": "no-store" } },
    );
  }
  audit({
    actor: identity,
    action: "source.upload",
    workspaceId,
    outcome: "failure",
    detail: { reason: result.error },
  });
  return json(result, { status: 400, headers: { "cache-control": "no-store" } });
});
