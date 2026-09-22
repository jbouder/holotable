import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { route } from "@/lib/http";
import { getDashboardById } from "@/lib/db/repo";
import { buildDashboardExport, exportFilename } from "@/lib/dashboard-export";

export const runtime = "nodejs";

/**
 * Download the current version of a dashboard as a JSON file.
 *
 * A viewer may export: the file carries the spec they can already see rendered
 * and the panel SQL they can already open from the panel menu, and nothing
 * else — no workspace, no author, and (invariant 5) no connection detail,
 * because a panel names its source by an opaque id.
 *
 * The response is built here rather than through `json()` because it needs a
 * `Content-Disposition`, and it is pretty-printed because the point of the
 * file is that a person can read it and put it under review.
 */
export const GET = route(
  "dashboards.export",
  async (_req: Request, ctx: RouteContext<"/api/dashboards/[id]/export">) => {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const dashboard = await getDashboardById(id);
    if (!dashboard) throw new HttpError(404, "dashboard not found");

    assertAuthorized(identity, "dashboard:view", {
      workspaceId: dashboard.workspaceId,
    });

    const payload = buildDashboardExport({
      spec: dashboard.spec,
      version: dashboard.version,
    });
    return new Response(`${JSON.stringify(payload, null, 2)}\n`, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFilename(dashboard.spec.title)}"`,
        // An export is a point-in-time copy of a mutable dashboard; a cached
        // one would hand back a version the user has already edited past.
        "Cache-Control": "no-store",
      },
    });
  },
);
