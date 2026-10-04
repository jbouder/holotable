import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { json, route } from "@/lib/http";
import { getDashboardById, getDashboardVersion } from "@/lib/db/repo";
import { VersionNumber } from "@/lib/dashboard-versions";

export const runtime = "nodejs";

/**
 * One version of a dashboard, with its spec upgraded to the current IR (#73).
 * Authorized `dashboard:view` against the dashboard's own workspace, read from
 * the stored row — never from the request.
 */
export const GET = route(
  "dashboards.versions.get",
  async (_req: Request, ctx: RouteContext<"/api/dashboards/[id]/versions/[version]">) => {
    const identity = await requireIdentity();
    const { id, version: raw } = await ctx.params;
    const dashboard = await getDashboardById(id);
    if (!dashboard) throw new HttpError(404, "dashboard not found");

    assertAuthorized(
      identity,
      "dashboard:view",
      { workspaceId: dashboard.workspaceId },
      { type: "dashboard", id },
    );

    const version = VersionNumber.safeParse(raw);
    if (!version.success) throw new HttpError(400, "invalid version");

    const detail = await getDashboardVersion(id, version.data);
    if (!detail) throw new HttpError(404, "version not found");
    return json({ version: detail });
  },
);
