import { baseSystem } from "@/lib/ai/generate";
import { assertAuthorized, HttpError, requireIdentity } from "@/lib/auth/authorize";
import { getSourceById } from "@/lib/db/repo";
import { json, route } from "@/lib/http";
import { WorkspaceId } from "@/lib/workspace-limits";
import { workspacePromptFor } from "@/lib/workspace-prompt-service";

export const runtime = "nodejs";

/**
 * The system prompt a generation against `?sourceId=` in this workspace is
 * given (#66), composed exactly as `/api/generate` composes it, so an editor
 * can see what the model was told. The fence tokens are fresh on every call,
 * as they are on every generation.
 *
 * Authorization is `dashboard:generate` in the path's workspace, and the
 * source must belong to it: the source's own record decides that, never the
 * query string.
 */
export const GET = route(
  "workspaces.prompt.preview",
  async (req: Request, ctx: RouteContext<"/api/workspaces/[id]/prompt/preview">) => {
    const identity = await requireIdentity();
    const workspaceId = WorkspaceId.safeParse((await ctx.params).id);
    if (!workspaceId.success) throw new HttpError(400, "invalid workspace id");
    assertAuthorized(
      identity,
      "dashboard:generate",
      { workspaceId: workspaceId.data },
      { type: "workspace", id: workspaceId.data },
    );
    const sourceId = new URL(req.url).searchParams.get("sourceId");
    if (!sourceId) throw new HttpError(400, "sourceId is required");
    const source = await getSourceById(sourceId);
    if (!source || source.tombstonedAt || source.workspaceId !== workspaceId.data) {
      throw new HttpError(404, "no such source in this workspace");
    }
    return json({
      sourceId: source.id,
      system: baseSystem(source, await workspacePromptFor(source)),
    });
  },
);
