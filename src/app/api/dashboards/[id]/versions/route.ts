import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { json, route } from "@/lib/http";
import { getDashboardById, listDashboardVersions } from "@/lib/db/repo";
import { VersionListQuery } from "@/lib/dashboard-versions";

export const runtime = "nodejs";

/**
 * A page of the dashboard's version history, newest first, without specs
 * (#73). Anyone who may view the dashboard may read its history: every past
 * version is a spec they could already have seen rendered when it was current.
 */
export const GET = route(
  "dashboards.versions.list",
  async (req: Request, ctx: RouteContext<"/api/dashboards/[id]/versions">) => {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const dashboard = await getDashboardById(id);
    if (!dashboard) throw new HttpError(404, "dashboard not found");

    assertAuthorized(
      identity,
      "dashboard:view",
      { workspaceId: dashboard.workspaceId },
      { type: "dashboard", id },
    );

    const params = new URL(req.url).searchParams;
    const parsed = VersionListQuery.safeParse({
      before: params.get("before") ?? undefined,
      limit: params.get("limit") ?? undefined,
    });
    if (!parsed.success) throw new HttpError(400, "invalid before or limit");

    const page = await listDashboardVersions(id, parsed.data);
    return json({ ...page, current: dashboard.version });
  },
);
