import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { json, route } from "@/lib/http";
import { getSourceById } from "@/lib/db/repo";
import { testSource } from "@/lib/timescaledb/client";

export const runtime = "nodejs";

/** Test connectivity for a source (source-admin). */
export const POST = route(
  "sources.test",
  async (_req: Request, ctx: RouteContext<"/api/sources/[id]/test">) => {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const source = await getSourceById(id);
    if (!source) throw new HttpError(404, "source not found");

    assertAuthorized(identity, "source:manage", { workspaceId: source.workspaceId });
    const result = await testSource(source);
    return json(result);
  },
);
