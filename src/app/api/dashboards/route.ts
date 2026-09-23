import { z } from "zod";
import {
  requireIdentity,
  assertAuthorized,
  authorizedWorkspaces,
} from "@/lib/auth/authorize";
import { readJson, json, route } from "@/lib/http";
import { listDashboards, createDashboard } from "@/lib/db/repo";
import { resolveAndValidateDashboard } from "@/lib/dashboard-service";
import { PAGE_SIZE, pageOffset, parseDashboardQuery } from "@/lib/dashboard-list";
import { Dashboard } from "@/lib/ir";

export const runtime = "nodejs";

/**
 * List dashboards across every workspace the caller can view.
 *
 * `workspaceId` and `editable` only NARROW that set — the candidate
 * workspaces still come from the validated claims and every one of them is
 * re-checked through `can()`, so a workspace id in the query string can never
 * widen what is returned. `editable=true` is what the Explore "save as panel"
 * picker asks for: listing a dashboard the caller cannot update would offer a
 * save the API would then refuse.
 *
 * `q`, `tag`, `sort` and `page` narrow it further (#80), and `id` narrows it to
 * a named set — which is how the recently-viewed strip turns ids a browser
 * kept into titles. None of them can widen it either: they are applied inside
 * the same per-workspace query, after authorization has already chosen the
 * workspaces.
 *
 * `total` counts what the filters match across all the authorized workspaces,
 * which is what the pager needs; the page itself is taken per workspace, so a
 * caller spanning several sees at most `PAGE_SIZE` from each.
 */
export const GET = route("dashboards.list", async (req: Request) => {
  const identity = await requireIdentity();
  const params = new URL(req.url).searchParams;
  const only = params.get("workspaceId");
  const action =
    params.get("editable") === "true" ? "dashboard:update" : "dashboard:view";

  const query = parseDashboardQuery(params);
  const ids = params
    .getAll("id")
    .flatMap((v) => v.split(","))
    .filter(Boolean);

  const workspaces = authorizedWorkspaces(identity, action, only);
  const pages = await Promise.all(
    workspaces.map((w) =>
      listDashboards(w, {
        search: query.search,
        tags: query.tags,
        sort: query.sort,
        limit: PAGE_SIZE,
        offset: pageOffset(query),
        userSub: identity.sub,
        favoritesOnly: params.get("favorites") === "true",
        ids: ids.length ? ids : undefined,
      }),
    ),
  );

  return json({
    dashboards: pages.flatMap((p) => p.dashboards),
    total: pages.reduce((sum, p) => sum + p.total, 0),
  });
});

const CreateBody = z.object({ spec: Dashboard });

/**
 * Create a dashboard. The workspace is derived from the trusted source records
 * referenced by the spec (never from a request field), then create is
 * authorized against that workspace.
 */
export const POST = route("dashboards.create", async (req: Request) => {
  const identity = await requireIdentity();
  const { spec } = await readJson(req, CreateBody);

  const { workspaceId } = await resolveAndValidateDashboard(spec);
  assertAuthorized(identity, "dashboard:create", { workspaceId });

  const record = await createDashboard({
    workspaceId,
    createdBy: identity.sub,
    spec,
  });
  return json({ dashboard: record }, { status: 201 });
});
