import { can, requireIdentity, authorizedWorkspaces } from "@/lib/auth/authorize";
import { json, route } from "@/lib/http";
import { listDashboards, listSources } from "@/lib/db/repo";
import { PER_SECTION, projectSource, type SearchResults } from "@/lib/command-palette";
import { SEARCH_MAX } from "@/lib/dashboard-list";

export const runtime = "nodejs";

/**
 * What the command palette searches: dashboards and sources, across every
 * workspace the caller can already reach.
 *
 * The candidate workspaces come from the validated claims by way of
 * `authorizedWorkspaces`, and `q` only narrows within them — there is no
 * workspace parameter to widen, because the palette has no business naming one.
 * A result therefore cannot be something the identity could not already open.
 *
 * A source is projected to its id, name and workspace. `SourceRecord` carries
 * the connection config and the catalog, and none of that has any business in
 * a search result (invariant 5): the palette needs a name and somewhere to go.
 */
export const GET = route("search", async (req: Request) => {
  const identity = await requireIdentity();
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, SEARCH_MAX);

  const [dashboards, sources] = await Promise.all([
    searchDashboards(identity, q),
    searchSources(identity, q),
  ]);

  return json({ dashboards, sources } satisfies SearchResults);
});

type Identity = Awaited<ReturnType<typeof requireIdentity>>;

async function searchDashboards(
  identity: Identity,
  q: string,
): Promise<SearchResults["dashboards"]> {
  const workspaces = authorizedWorkspaces(identity, "dashboard:view");
  const pages = await Promise.all(
    workspaces.map((workspaceId) =>
      listDashboards(workspaceId, {
        search: q,
        sort: "title",
        // Each workspace contributes at most a section's worth; the palette
        // ranks the union and caps it again.
        limit: PER_SECTION,
      }),
    ),
  );
  return pages
    .flatMap((p) => p.dashboards)
    .map((d) => ({ id: d.id, title: d.title, workspaceId: d.workspaceId }));
}

/**
 * Sources have no `search` in the repo layer and no paging — a workspace holds
 * a handful of them, not hundreds — so the name match happens here over the
 * rows the workspace scope already decided.
 */
async function searchSources(
  identity: Identity,
  q: string,
): Promise<SearchResults["sources"]> {
  const workspaces = authorizedWorkspaces(identity, "source:use");
  const needle = q.toLowerCase();
  const perWorkspace = await Promise.all(
    workspaces.map(async (workspaceId) => {
      const sources = await listSources(workspaceId);
      // `canManage` is decided here, from the identity, so the palette never
      // offers a refresh the route would refuse. The route checks it again.
      const canManage = can(identity, "source:manage", { workspaceId });
      return sources
        .filter((s) => !needle || s.name.toLowerCase().includes(needle))
        .slice(0, PER_SECTION)
        .map((s) => projectSource(s, canManage));
    }),
  );
  return perWorkspace.flat();
}
