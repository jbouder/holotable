import { can, getIdentity } from "@/lib/auth/authorize";
import { accessibleWorkspaces, hasWorkspaceRole } from "@/lib/auth/claims";
import { listSources } from "@/lib/db/repo";
import { catalogHealth } from "@/lib/catalog/health";
import { buildStarters } from "@/lib/prompts/starters";
import { config } from "@/lib/config";
import { SignIn } from "@/components/sign-in";
import { ExploreClient } from "./explore-client";

export const dynamic = "force-dynamic";

export default async function ExplorePage() {
  const identity = await getIdentity();
  if (!identity) return <SignIn />;

  // Sources from every workspace the caller can edit in (same scope as
  // generation — exploration runs guarded queries against these sources).
  const workspaces = accessibleWorkspaces(identity).filter(
    (w) => identity.platformAdmin || hasWorkspaceRole(identity, w, "editor"),
  );
  const lists = await Promise.all(workspaces.map((w) => listSources(w)));
  const sources = lists.flat().map((s) => ({
    id: s.id,
    name: s.name,
    workspaceId: s.workspaceId,
    // Decided here, not in the browser: the staleness threshold is an
    // environment setting, and `/api/generate` refuses on this same call.
    catalog: catalogHealth(s),
    // Derived here because the catalog stays on the server: the browser is
    // handed the suggestions, never the table and column list they were
    // built from.
    starters: buildStarters(s, "panel"),
    canRefresh: can(identity, "source:manage", { workspaceId: s.workspaceId }),
  }));

  return (
    <ExploreClient
      sources={sources}
      model={config.aiModel}
      // Defaults for a dashboard created from a result. The server stays the
      // authority for resolving these expressions at execution time.
      defaultTimeRange={{ from: config.defaultTimeFrom, to: config.defaultTimeTo }}
      defaultRefreshIntervalMs={config.defaultRefreshIntervalMs}
    />
  );
}
