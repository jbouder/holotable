import { z } from "zod";
import {
  requireIdentity,
  assertAuthorized,
  errorResponse,
  HttpError,
} from "@/lib/auth/authorize";
import { readJson, json } from "@/lib/http";
import { getSourceById, updateSource, deleteSource } from "@/lib/db/repo";
import { SourceConfig } from "@/lib/registry";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: RouteContext<"/api/sources/[id]">) {
  try {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const source = await getSourceById(id);
    if (!source) throw new HttpError(404, "source not found");

    assertAuthorized(identity, "source:use", { workspaceId: source.workspaceId });
    return json({ source });
  } catch (err) {
    return errorResponse(err);
  }
}

const UpdateBody = z.object({
  name: z.string().min(1).max(200).optional(),
  config: SourceConfig.optional(),
  secretRef: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/, "secretRef must be an UPPER_SNAKE env family")
    .optional(),
});

export async function PUT(req: Request, ctx: RouteContext<"/api/sources/[id]">) {
  try {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const source = await getSourceById(id);
    if (!source) throw new HttpError(404, "source not found");

    assertAuthorized(identity, "source:manage", { workspaceId: source.workspaceId });

    const patch = await readJson(req, UpdateBody);
    const updated = await updateSource(source.workspaceId, id, patch);
    if (!updated) throw new HttpError(409, "source is tombstoned and cannot be edited");
    return json({ source: updated });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Delete a source; referenced sources are tombstoned rather than removed. */
export async function DELETE(_req: Request, ctx: RouteContext<"/api/sources/[id]">) {
  try {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const source = await getSourceById(id);
    if (!source) throw new HttpError(404, "source not found");

    assertAuthorized(identity, "source:manage", { workspaceId: source.workspaceId });
    const outcome = await deleteSource(source.workspaceId, id);
    return json({ outcome });
  } catch (err) {
    return errorResponse(err);
  }
}
