import { z } from "zod";
import { audit } from "@/lib/audit";
import { assertAuthorized, HttpError, requireIdentity } from "@/lib/auth/authorize";
import { revoke } from "@/lib/auth/revocation";
import { shareSessionId } from "@/lib/auth/share";
import { getDashboardById } from "@/lib/db/repo";
import { pgShareStore } from "@/lib/db/shares";
import { json, route } from "@/lib/http";

export const runtime = "nodejs";

/**
 * Revoke a share link (#65), at once: the next request with it is refused,
 * and its open streams are closed now rather than at their next re-check.
 */
export const DELETE = route(
  "dashboards.shares.revoke",
  async (_req: Request, ctx: RouteContext<"/api/dashboards/[id]/shares/[shareId]">) => {
    const identity = await requireIdentity();
    const { id, shareId } = await ctx.params;
    const dashboard = await getDashboardById(id);
    if (!dashboard) throw new HttpError(404, "dashboard not found");
    assertAuthorized(
      identity,
      "dashboard:update",
      { workspaceId: dashboard.workspaceId, dashboardId: id },
      { type: "dashboard", id },
    );
    const parsed = z.uuid().safeParse(shareId);
    if (!parsed.success) throw new HttpError(404, "share not found");
    const revoked = await pgShareStore.revoke({
      id: parsed.data,
      dashboardId: id,
      workspaceId: dashboard.workspaceId,
    });
    if (!revoked) throw new HttpError(404, "share not found");
    revoke({ sid: shareSessionId(parsed.data) });
    audit({
      actor: identity,
      action: "share.revoke",
      workspaceId: dashboard.workspaceId,
      resource: { type: "dashboard", id },
      detail: { shareId: parsed.data },
    });
    return json({ ok: true });
  },
);
