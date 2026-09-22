import { z } from "zod";
import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { readJson, json, route } from "@/lib/http";
import {
  getDashboardById,
  saveDashboardVersion,
  softDeleteDashboard,
} from "@/lib/db/repo";
import { resolveAndValidateDashboard } from "@/lib/dashboard-service";
import { invalidatePoller } from "@/lib/poller/registry";
import { Dashboard } from "@/lib/ir";

export const runtime = "nodejs";

export const GET = route(
  "dashboards.get",
  async (_req: Request, ctx: RouteContext<"/api/dashboards/[id]">) => {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const dashboard = await getDashboardById(id);
    if (!dashboard) throw new HttpError(404, "dashboard not found");

    assertAuthorized(identity, "dashboard:view", {
      workspaceId: dashboard.workspaceId,
    });
    return json({ dashboard });
  },
);

const UpdateBody = z.object({ spec: Dashboard });

/** Save a new immutable version of the dashboard (editor). */
export const PUT = route(
  "dashboards.update",
  async (req: Request, ctx: RouteContext<"/api/dashboards/[id]">) => {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const existing = await getDashboardById(id);
    if (!existing) throw new HttpError(404, "dashboard not found");

    const { spec } = await readJson(req, UpdateBody);
    const { workspaceId } = await resolveAndValidateDashboard(spec);

    // Authorize against BOTH the existing dashboard workspace and the resolved
    // one; they must match (no cross-workspace moves).
    if (workspaceId !== existing.workspaceId) {
      throw new HttpError(400, "panels reference a different workspace");
    }
    assertAuthorized(identity, "dashboard:update", { workspaceId });

    const record = await saveDashboardVersion({
      dashboardId: id,
      createdBy: identity.sub,
      spec,
    });
    invalidatePoller(id);
    return json({ dashboard: record });
  },
);

/** Delete a dashboard (owner, workspace source-admin, or platform admin). */
export const DELETE = route(
  "dashboards.delete",
  async (_req: Request, ctx: RouteContext<"/api/dashboards/[id]">) => {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const existing = await getDashboardById(id);
    if (!existing) throw new HttpError(404, "dashboard not found");

    assertAuthorized(identity, "dashboard:delete", {
      workspaceId: existing.workspaceId,
      ownerSub: existing.createdBy,
    });

    await softDeleteDashboard(id);
    invalidatePoller(id);
    return json({ ok: true });
  },
);
