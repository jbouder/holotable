import { assertAuthorized, HttpError, requireIdentity } from "@/lib/auth/authorize";
import { audit } from "@/lib/audit";
import { getSourceById } from "@/lib/db/repo";
import { json, route } from "@/lib/http";
import {
  addUploadedFiles,
  sweepUploads,
  UPLOAD_RATE_PER_MINUTE,
  uploadRateStore,
} from "@/lib/sources/server/registry";

export const runtime = "nodejs";
// A large file on a slow link takes a while; the byte cap bounds it.
export const maxDuration = 300;

/**
 * Add CSV, JSON or Excel files to an existing upload source (#604): the
 * source by id in the path, and a `multipart/form-data` body of `files`, as
 * `POST /api/sources/duckdb/uploads` takes.
 *
 * - the source is loaded on the server and `source:manage` authorized in
 *   *its* workspace, never one from the request; a tombstoned source takes
 *   nothing; rate limited in the same bucket as the create-time route;
 * - only a source made by uploading takes files (its path is one of its own
 *   workspace's upload directories, resolved by the guard before anything
 *   is written); any other kind or layout is refused by name;
 * - all or nothing for this request's own files: a file whose table the
 *   source already has is refused by name, `DUCKDB_UPLOAD_MAX_FILES` counts
 *   the files already there, and a refusal leaves the existing files as
 *   they were and nothing new behind;
 * - answered like the create-time route, `{ ok: true, path, files }` with
 *   the source's own path, or `{ ok: false, error, file? }` naming no server
 *   path. The files are on disk, not yet tables: the browser opens the
 *   catalog refresh, where the new tables are reviewed and applied, so the
 *   allowlist is never edited here;
 * - audited as `source.upload` on the source, with `added: true`.
 */
export const POST = route(
  "sources.uploads",
  async (req: Request, ctx: RouteContext<"/api/sources/[id]/uploads">) => {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const source = await getSourceById(id);
    if (!source) throw new HttpError(404, "source not found");

    assertAuthorized(
      identity,
      "source:manage",
      { workspaceId: source.workspaceId },
      { type: "source", id },
    );
    if (source.tombstonedAt) throw new HttpError(409, "source is tombstoned");

    const decision = await uploadRateStore.take(
      `${source.workspaceId}\u0000${identity.sub}`,
      { perMinute: UPLOAD_RATE_PER_MINUTE },
      Date.now(),
    );
    if (!decision.allowed) {
      const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      throw new HttpError(
        429,
        `too many uploads: ${UPLOAD_RATE_PER_MINUTE} per minute per user in this workspace; retry after ${seconds}s`,
        { "Retry-After": String(seconds) },
      );
    }

    const length = Number(req.headers.get("content-length"));
    const result = await addUploadedFiles(source, {
      contentType: req.headers.get("content-type"),
      contentLength: Number.isFinite(length) && length > 0 ? length : null,
      body: req.body,
    });
    if (result.ok) {
      audit({
        actor: identity,
        action: "source.upload",
        workspaceId: source.workspaceId,
        resource: { type: "source", id },
        detail: {
          added: true,
          files: result.files.length,
          bytes: result.files.reduce((sum, f) => sum + f.bytes, 0),
        },
      });
      void sweepUploads(source.workspaceId);
      return json(
        { ok: true, path: result.path, files: result.files },
        { headers: { "cache-control": "no-store" } },
      );
    }
    audit({
      actor: identity,
      action: "source.upload",
      workspaceId: source.workspaceId,
      resource: { type: "source", id },
      outcome: "failure",
      detail: { added: true, reason: result.error },
    });
    return json(result, { status: 400, headers: { "cache-control": "no-store" } });
  },
);
