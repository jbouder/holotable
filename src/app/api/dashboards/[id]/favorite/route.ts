import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { json, route } from "@/lib/http";
import { getDashboardById, setDashboardFavorite } from "@/lib/db/repo";

export const runtime = "nodejs";

/**
 * Star and unstar a dashboard for the caller (#80).
 *
 * A favourite belongs to the person, not to the dashboard, so the subject is
 * always the validated identity's own and never a request field — there is no
 * body at all, which is what makes "favourite this on someone else's behalf"
 * unrepresentable rather than merely refused.
 *
 * `dashboard:view` is the gate: being able to see a dashboard is exactly the
 * right to keep a bookmark to it, and a viewer who cannot edit still needs the
 * list to be navigable.
 */
async function authorizeFavorite(id: string) {
  const identity = await requireIdentity();
  const dashboard = await getDashboardById(id);
  if (!dashboard) throw new HttpError(404, "dashboard not found");
  assertAuthorized(identity, "dashboard:view", {
    workspaceId: dashboard.workspaceId,
  });
  return identity;
}

/** Star it. Idempotent: starring twice is a star. */
export const PUT = route(
  "dashboards.favorite",
  async (_req: Request, ctx: RouteContext<"/api/dashboards/[id]/favorite">) => {
    const { id } = await ctx.params;
    const identity = await authorizeFavorite(id);
    await setDashboardFavorite(identity.sub, id, true);
    return json({ favorite: true });
  },
);

/** Unstar it. Idempotent the same way. */
export const DELETE = route(
  "dashboards.unfavorite",
  async (_req: Request, ctx: RouteContext<"/api/dashboards/[id]/favorite">) => {
    const { id } = await ctx.params;
    const identity = await authorizeFavorite(id);
    await setDashboardFavorite(identity.sub, id, false);
    return json({ favorite: false });
  },
);
