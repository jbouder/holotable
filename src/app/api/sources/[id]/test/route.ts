import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { json, route } from "@/lib/http";
import { audit } from "@/lib/audit";
import { getSourceById, recordCatalogFacts } from "@/lib/db/repo";
import { serverKind } from "@/lib/sources/server/registry";

export const runtime = "nodejs";

/**
 * Test connectivity for a source (source-admin), and record what the server
 * turned out to be (`catalog_facts`, #557).
 */
export const POST = route(
  "sources.test",
  async (_req: Request, ctx: RouteContext<"/api/sources/[id]/test">) => {
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
    const kind = serverKind(source);
    const result = await kind.test(source);
    // What the server said it is (#557), from the result this server just
    // produced; the request has no body to set it from.
    const facts = kind.testFacts(result);
    if (facts) await recordCatalogFacts(source.workspaceId, id, facts);
    audit({
      actor: identity,
      action: "source.test",
      workspaceId: source.workspaceId,
      resource: { type: "source", id },
      outcome: result.ok ? "success" : "failure",
    });
    return json(result);
  },
);
