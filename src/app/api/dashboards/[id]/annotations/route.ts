import { assertAuthorized, HttpError, requireIdentity } from "@/lib/auth/authorize";
import { dashboardAnnotations } from "@/lib/annotation-service";
import { pgAnnotationStore } from "@/lib/db/annotations";
import { getDashboardById } from "@/lib/db/repo";
import { json, route } from "@/lib/http";
import { TimeRange } from "@/lib/ir";
import { TimeRangeError } from "@/lib/time";

export const runtime = "nodejs";

/**
 * The annotations a dashboard shows (#68), for the window a viewer is looking
 * at. Viewer role on the dashboard's own workspace, which is also the only
 * workspace whose annotations are read.
 */
export const GET = route(
  "dashboards.annotations",
  async (req: Request, ctx: RouteContext<"/api/dashboards/[id]/annotations">) => {
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

    const url = new URL(req.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    let shown = dashboard.spec.timeRange;
    if (from !== null || to !== null) {
      const parsed = TimeRange.safeParse({ from, to });
      if (!parsed.success) throw new HttpError(400, "invalid time-range parameters");
      shown = parsed.data;
    }
    try {
      const annotations = await dashboardAnnotations({
        dashboard,
        shown,
        store: pgAnnotationStore,
      });
      return json({ annotations });
    } catch (err) {
      if (err instanceof TimeRangeError) {
        throw new HttpError(400, err.message, {}, "validation");
      }
      throw err;
    }
  },
);
