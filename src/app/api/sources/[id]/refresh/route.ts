import {
  requireIdentity,
  assertAuthorized,
  errorResponse,
  HttpError,
} from "@/lib/auth/authorize";
import { json } from "@/lib/http";
import { getSourceById, updateSource } from "@/lib/db/repo";
import { refreshCatalog } from "@/lib/timescaledb/catalog";

export const runtime = "nodejs";
export const maxDuration = 30;

/** Refresh a source's catalog by introspecting the live schema (source-admin). */
export async function POST(_req: Request, ctx: RouteContext<"/api/sources/[id]/refresh">) {
  try {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const source = await getSourceById(id);
    if (!source) throw new HttpError(404, "source not found");

    assertAuthorized(identity, "source:manage", { workspaceId: source.workspaceId });

    const config = await refreshCatalog(source);
    const updated = await updateSource(source.workspaceId, id, { config });
    if (!updated) throw new HttpError(409, "source is tombstoned");
    return json({ source: updated });
  } catch (err) {
    return errorResponse(err);
  }
}
