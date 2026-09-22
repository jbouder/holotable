import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { json, route } from "@/lib/http";
import { getSourceById, updateSource } from "@/lib/db/repo";
import { catalogHealth } from "@/lib/catalog/health";
import { refreshCatalog } from "@/lib/timescaledb/catalog";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Refresh a source's catalog by introspecting the live schema (source-admin).
 *
 * This is the only writer of the two freshness facts, and it writes both every
 * time: the timestamp that stops the source being reported as never refreshed,
 * and the list of allowlisted tables the database no longer has — which is
 * emptied here on the run that finds them again.
 */
export const POST = route(
  "sources.refresh",
  async (_req: Request, ctx: RouteContext<"/api/sources/[id]/refresh">) => {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const source = await getSourceById(id);
    if (!source) throw new HttpError(404, "source not found");

    assertAuthorized(identity, "source:manage", { workspaceId: source.workspaceId });

    const { config, missingTables } = await refreshCatalog(source);
    const updated = await updateSource(source.workspaceId, id, {
      config,
      catalogRefreshedAt: new Date(),
      catalogMissingTables: missingTables,
    });
    if (!updated) throw new HttpError(409, "source is tombstoned");
    return json({ source: updated, catalogHealth: catalogHealth(updated) });
  },
);
