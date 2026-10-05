import { z } from "zod";
import { audit } from "@/lib/audit";
import { assertAuthorized, HttpError, requireIdentity } from "@/lib/auth/authorize";
import { pgApiTokenStore } from "@/lib/db/api-tokens";
import { json, route } from "@/lib/http";
import { WorkspaceId } from "@/lib/workspace-limits";

export const runtime = "nodejs";

/**
 * Revoke a service-account token (#288). Every request looks its row up, so
 * the next one with it is refused. Another workspace's token is a 404.
 */
export const DELETE = route(
  "workspaces.tokens.revoke",
  async (_req: Request, ctx: RouteContext<"/api/workspaces/[id]/tokens/[tokenId]">) => {
    const identity = await requireIdentity();
    const { id, tokenId } = await ctx.params;
    const workspaceId = WorkspaceId.safeParse(id);
    if (!workspaceId.success) throw new HttpError(400, "invalid workspace id");
    assertAuthorized(
      identity,
      "source:manage",
      { workspaceId: workspaceId.data },
      { type: "workspace", id: workspaceId.data },
    );
    const parsed = z.uuid().safeParse(tokenId);
    if (!parsed.success) throw new HttpError(404, "token not found");
    const revoked = await pgApiTokenStore.revoke({
      id: parsed.data,
      workspaceId: workspaceId.data,
    });
    if (!revoked) throw new HttpError(404, "token not found");
    audit({
      actor: identity,
      action: "token.revoke",
      workspaceId: workspaceId.data,
      resource: { type: "workspace", id: workspaceId.data },
      detail: { tokenId: parsed.data },
    });
    return json({ ok: true });
  },
);
