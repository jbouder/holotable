import { z } from "zod";
import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { readJson, json, route } from "@/lib/http";
import { getSourceById, updateSource, deleteSource } from "@/lib/db/repo";
import { SourceConfig } from "@/lib/registry";
import { SECRET_REF_MESSAGE, SECRET_REF_PATTERN } from "@/lib/secret-refs";
import { requireGrantedSecretRef } from "@/lib/secrets/http";

export const runtime = "nodejs";

export const GET = route(
  "sources.get",
  async (_req: Request, ctx: RouteContext<"/api/sources/[id]">) => {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const source = await getSourceById(id);
    if (!source) throw new HttpError(404, "source not found");

    assertAuthorized(identity, "source:use", { workspaceId: source.workspaceId });
    return json({ source });
  },
);

const UpdateBody = z.object({
  name: z.string().min(1).max(200).optional(),
  config: SourceConfig.optional(),
  secretRef: z.string().regex(SECRET_REF_PATTERN, SECRET_REF_MESSAGE).optional(),
});

export const PUT = route(
  "sources.update",
  async (req: Request, ctx: RouteContext<"/api/sources/[id]">) => {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const source = await getSourceById(id);
    if (!source) throw new HttpError(404, "source not found");

    assertAuthorized(identity, "source:manage", { workspaceId: source.workspaceId });

    const patch = await readJson(req, UpdateBody);
    // Only a changed ref is checked here: an unrelated edit to a source whose
    // grant has since been withdrawn still saves, and still cannot connect.
    if (patch.secretRef !== undefined && patch.secretRef !== source.secretRef) {
      requireGrantedSecretRef(patch.secretRef, source.workspaceId);
    }
    const updated = await updateSource(source.workspaceId, id, patch);
    if (!updated) throw new HttpError(409, "source is tombstoned and cannot be edited");
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

    assertAuthorized(identity, "source:manage", { workspaceId: source.workspaceId });
    const outcome = await deleteSource(source.workspaceId, id);
    return json({ outcome });
  },
);
