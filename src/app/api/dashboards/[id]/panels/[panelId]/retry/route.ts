import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { json, route } from "@/lib/http";
import { getDashboardById } from "@/lib/db/repo";
import { retryPanel } from "@/lib/poller/registry";

export const runtime = "nodejs";

/**
 * "Retry now" on a panel the poller is backing off from (#44).
 *
 * `dashboard:view` is the gate, the same as the stream's: a viewer who can see
 * the panel failing can ask for it to be tried again. It runs only a panel
 * already in the dashboard's running poller, with the statement and the row
 * scope that poller already has, so it can run nothing the viewer could not
 * already watch run. The poller refuses a panel that is not backing off and
 * any retry within `MIN_REFRESH_INTERVAL_MS` of the last attempt, so the
 * button is never a faster cadence than a refresh.
 *
 * `started` is how many pollers ran it, and 0 when nothing was due. The result
 * arrives on the stream, not in this response.
 */
export const POST = route(
  "dashboards.panel_retry",
  async (
    _req: Request,
    ctx: RouteContext<"/api/dashboards/[id]/panels/[panelId]/retry">,
  ) => {
    const identity = await requireIdentity();
    const { id, panelId } = await ctx.params;
    const dashboard = await getDashboardById(id);
    if (!dashboard) throw new HttpError(404, "dashboard not found");
    assertAuthorized(
      identity,
      "dashboard:view",
      { workspaceId: dashboard.workspaceId },
      { type: "dashboard", id },
    );
    return json({ started: retryPanel(id, panelId) });
  },
);
