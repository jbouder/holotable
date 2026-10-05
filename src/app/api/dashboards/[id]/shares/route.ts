import { audit } from "@/lib/audit";
import { assertAuthorized, HttpError, requireIdentity } from "@/lib/auth/authorize";
import { publicOrigin } from "@/lib/auth/origin";
import { shareTokenHash, signShareToken } from "@/lib/auth/share";
import { getDashboardById } from "@/lib/db/repo";
import { pgShareStore } from "@/lib/db/shares";
import { json, readJson, route } from "@/lib/http";
import { embedPath, ShareRequest, shareView } from "@/lib/share-view";

export const runtime = "nodejs";

/** The dashboard, authorized for managing its share links: editor role. */
async function managedDashboard(id: string) {
  const identity = await requireIdentity();
  const dashboard = await getDashboardById(id);
  if (!dashboard) throw new HttpError(404, "dashboard not found");
  assertAuthorized(
    identity,
    "dashboard:update",
    { workspaceId: dashboard.workspaceId, dashboardId: id },
    { type: "dashboard", id },
  );
  return { identity, dashboard };
}

/** The dashboard's share links, without their tokens (#65). */
export const GET = route(
  "dashboards.shares.list",
  async (_req: Request, ctx: RouteContext<"/api/dashboards/[id]/shares">) => {
    const { id } = await ctx.params;
    const { dashboard } = await managedDashboard(id);
    const shares = await pgShareStore.list({
      dashboardId: id,
      workspaceId: dashboard.workspaceId,
    });
    return json({ shares: shares.map(shareView) });
  },
);

/**
 * Mint a read-only share link (#65). The token is in this response and
 * nowhere else: the row keeps its hash, so it cannot be shown again.
 */
export const POST = route(
  "dashboards.shares.create",
  async (req: Request, ctx: RouteContext<"/api/dashboards/[id]/shares">) => {
    const { id } = await ctx.params;
    const { identity, dashboard } = await managedDashboard(id);
    const body = await readJson(req, ShareRequest, { maxBytes: 4_096 });

    const shareId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + body.expiresInDays * 86_400_000);
    const token = await signShareToken({
      sid: shareId,
      did: id,
      exp: Math.floor(expiresAt.getTime() / 1000),
      org: body.allowedOrigins ?? [],
    });
    const share = await pgShareStore.create({
      id: shareId,
      dashboardId: id,
      workspaceId: dashboard.workspaceId,
      tokenHash: await shareTokenHash(token),
      label: body.label ?? null,
      allowedOrigins: body.allowedOrigins ?? [],
      timeRange: body.timeRange ?? null,
      createdBy: identity.sub,
      expiresAt: expiresAt.toISOString(),
    });
    audit({
      actor: identity,
      action: "share.create",
      workspaceId: dashboard.workspaceId,
      resource: { type: "dashboard", id },
      detail: {
        shareId,
        expiresAt: share.expiresAt,
        allowedOrigins: share.allowedOrigins,
        timeRange: share.timeRange,
      },
    });
    const path = embedPath(id, token);
    return json(
      {
        share: shareView(share),
        token,
        url: new URL(path, publicOrigin(req.headers, new URL(req.url))).toString(),
      },
      { status: 201 },
    );
  },
);
