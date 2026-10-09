import { z } from "zod";
import { requireIdentity, assertAuthorized, can, HttpError } from "@/lib/auth/authorize";
import { readJson, json, route } from "@/lib/http";
import { assertRowFilterSavable } from "@/lib/row-scope";
import { audit } from "@/lib/audit";
import { getSourceById, updateSource, deleteSource } from "@/lib/db/repo";
import { checkSecretRef, SourceConfig, SourceDraftFields } from "@/lib/registry";
import { sourceListing } from "@/lib/source-listing";
import { sameKind } from "@/lib/sources/registry";
import { serverKind } from "@/lib/sources/server/registry";
import { SECRET_REF_MESSAGE, SECRET_REF_PATTERN } from "@/lib/secret-refs";
import { requireGrantedSecretRef } from "@/lib/secrets/http";

export const runtime = "nodejs";

/**
 * One source. The full record for a source admin, and the same listing the
 * list route gives anyone else: no connection details, `secret_ref` or hidden
 * columns. The catalog itself is `GET /api/sources/[id]/catalog`.
 */
export const GET = route(
  "sources.get",
  async (_req: Request, ctx: RouteContext<"/api/sources/[id]">) => {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const source = await getSourceById(id);
    if (!source) throw new HttpError(404, "source not found");

    const scope = { workspaceId: source.workspaceId };
    assertAuthorized(identity, "source:use", scope, { type: "source", id });
    return json({
      source: can(identity, "source:manage", scope) ? source : sourceListing(source),
    });
  },
);

const UpdateBody = z.object({
  name: z.string().min(1).max(200).optional(),
  config: SourceConfig.optional(),
  /** A new reference, or `null` to clear it once a source needs none (#385). */
  secretRef: z
    .string()
    .regex(SECRET_REF_PATTERN, SECRET_REF_MESSAGE)
    .nullable()
    .optional(),
});

export const PUT = route(
  "sources.update",
  async (req: Request, ctx: RouteContext<"/api/sources/[id]">) => {
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

    const patch = await readJson(req, UpdateBody);
    // Only a changed ref is checked here: an unrelated edit to a source whose
    // grant has since been withdrawn still saves, and still cannot connect.
    if (
      patch.secretRef !== undefined &&
      patch.secretRef !== null &&
      patch.secretRef !== source.secretRef
    ) {
      requireGrantedSecretRef(patch.secretRef, source.workspaceId);
    }
    // A source's kind is what it is: an edit may change its config, never turn
    // it into another kind under the same id, which every panel names.
    if (patch.config && !sameKind(source, patch.config)) {
      throw new HttpError(
        400,
        `a ${source.kind} source cannot become a ${patch.config.kind} one`,
      );
    }
    if (patch.config) assertRowFilterSavable(patch.config);
    // The source as it would be saved needs a reference exactly when it needs
    // credentials (#385).
    const after = {
      config: patch.config ?? source.config,
      secretRef: patch.secretRef !== undefined ? patch.secretRef : source.secretRef,
    };
    const refProblem = SourceDraftFields.pick({ config: true })
      .extend({ secretRef: z.string().nullable() })
      .superRefine(checkSecretRef)
      .safeParse(after);
    if (!refProblem.success) {
      throw new HttpError(
        400,
        refProblem.error.issues[0]?.message ?? "invalid secretRef",
        {},
        "validation",
      );
    }
    if (patch.config) {
      const unreachable = await serverKind(source).checkConfig(patch.config);
      if (unreachable) throw new HttpError(400, unreachable, {}, "validation");
    }
    const updated = await updateSource(source.workspaceId, id, patch);
    if (!updated) throw new HttpError(409, "source is tombstoned and cannot be edited");
    audit({
      actor: identity,
      action: "source.update",
      workspaceId: source.workspaceId,
      resource: { type: "source", id },
      detail: { fields: Object.keys(patch), secretRef: patch.secretRef },
    });
    return json({ source: updated });
  },
);

/** Delete a source; referenced sources are tombstoned rather than removed. */
export const DELETE = route(
  "sources.delete",
  async (_req: Request, ctx: RouteContext<"/api/sources/[id]">) => {
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
    const outcome = await deleteSource(source.workspaceId, id);
    // Its connections would close at the idle timeout anyway; nothing will
    // check them out again, so close them now.
    await serverKind(source).dispose(id);
    audit({
      actor: identity,
      action: "source.delete",
      workspaceId: source.workspaceId,
      resource: { type: "source", id },
      // Removed outright, or tombstoned because a dashboard still uses it.
      detail: { effect: outcome },
    });
    return json({ outcome });
  },
);
