import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { json, route } from "@/lib/http";
import { getSourceById, sourceImpact } from "@/lib/db/repo";

export const runtime = "nodejs";

/**
 * What currently depends on this source.
 *
 * Gated on `source:manage` — the role that may delete the source — rather than
 * `source:use`, because the answer is a list of dashboards a viewer has no
 * need to obtain this way. The workspace comes from the stored source record
 * and is passed to the query, so the scope is the source's own workspace and
 * never a workspace named by the request.
 */
export const GET = route(
  "sources.impact",
  async (_req: Request, ctx: RouteContext<"/api/sources/[id]/impact">) => {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const source = await getSourceById(id);
    if (!source) throw new HttpError(404, "source not found");

    assertAuthorized(identity, "source:manage", { workspaceId: source.workspaceId });
    const impact = await sourceImpact(source.workspaceId, id);
    return json({ impact }, { headers: { "cache-control": "no-store" } });
  },
);
