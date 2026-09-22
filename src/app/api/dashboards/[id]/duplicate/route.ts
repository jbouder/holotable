import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { json, route } from "@/lib/http";
import { createDashboard, getDashboardById } from "@/lib/db/repo";
import { resolveAndValidateDashboard } from "@/lib/dashboard-service";
import { copyDashboardTitle } from "@/lib/dashboard-metadata";

export const runtime = "nodejs";

/**
 * Copy a dashboard into a new one at version 1 (#119).
 *
 * "Make one like that but for the other service" is otherwise a rebuild. The
 * copy is an ordinary dashboard the moment it exists — same spec, same
 * workspace, its own history — so nothing downstream has to know it was one.
 *
 * Three things are deliberate:
 *
 * - **Two permissions, not one.** Reading the original is `dashboard:view`;
 *   writing the copy is `dashboard:create`. They happen to coincide today for
 *   an editor and need not tomorrow.
 * - **The spec is re-validated** through `resolveAndValidateDashboard`, so a
 *   copy of a dashboard whose source has since been tombstoned fails loudly
 *   here rather than becoming a second broken dashboard.
 * - **The workspace comes from the trusted source records**, exactly as create
 *   does, and must be the one the original is in: duplicate is not a move.
 */
export const POST = route(
  "dashboards.duplicate",
  async (_req: Request, ctx: RouteContext<"/api/dashboards/[id]/duplicate">) => {
    const identity = await requireIdentity();
    const { id } = await ctx.params;

    const existing = await getDashboardById(id);
    if (!existing) throw new HttpError(404, "dashboard not found");
    assertAuthorized(identity, "dashboard:view", {
      workspaceId: existing.workspaceId,
    });

    const spec = {
      ...existing.spec,
      title: copyDashboardTitle(existing.spec.title),
    };
    const { workspaceId } = await resolveAndValidateDashboard(spec);
    if (workspaceId !== existing.workspaceId) {
      throw new HttpError(400, "panels reference a different workspace");
    }
    assertAuthorized(identity, "dashboard:create", { workspaceId });

    const record = await createDashboard({
      workspaceId,
      createdBy: identity.sub,
      spec,
      // The metadata comes along: a copy of the production API dashboard is
      // still about the production API, and re-tagging it by hand is the
      // step people forget.
      description: existing.description,
      tags: existing.tags,
    });
    return json({ dashboard: record }, { status: 201 });
  },
);
