import {
  requireIdentity,
  assertAuthorized,
  errorResponse,
  HttpError,
} from "@/lib/auth/authorize";
import { json } from "@/lib/http";
import { getSourceById } from "@/lib/db/repo";
import { testSource } from "@/lib/timescaledb/client";

export const runtime = "nodejs";

/** Test connectivity for a source (source-admin). */
export async function POST(_req: Request, ctx: RouteContext<"/api/sources/[id]/test">) {
  try {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const source = await getSourceById(id);
    if (!source) throw new HttpError(404, "source not found");

    assertAuthorized(identity, "source:manage", { workspaceId: source.workspaceId });
    const result = await testSource(source);
    return json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
