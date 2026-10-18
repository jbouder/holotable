import { authorizedWorkspaces, can, getIdentity } from "@/lib/auth/authorize";
import { isSqlSource } from "@/lib/sources/registry";
import { accessibleWorkspaces, hasWorkspaceRole } from "@/lib/auth/claims";
import { listSources } from "@/lib/db/repo";
import { catalogHealth } from "@/lib/catalog/health";
import { buildStarters } from "@/lib/prompts/starters";
import { buildFileTemplates } from "@/lib/builtin-templates-files";
import { effectiveModels } from "@/lib/ai/models";
import { SignIn } from "@/components/sign-in";
import { NewDashboardClient } from "./new-client";

export const dynamic = "force-dynamic";

export default async function NewDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const identity = await getIdentity();
  if (!identity) return <SignIn />;

  // Sources from every workspace the caller can edit in.
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
    // SQL catalogs only, until generation learns PromQL (#387).
    starters: isSqlSource(s) ? buildStarters(s, "dashboard") : [],
    // The starter dashboards its tables' column shapes are recognized as
    // (#606), built here for the same reason, and applied with no model.
    recognized: isSqlSource(s) ? buildFileTemplates(s, "dashboard") : [],
    canRefresh: can(identity, "source:manage", { workspaceId: s.workspaceId }),
  }));

  // `?source=<id>&template=<id>` (#606): where the sources page's offer
  // after an upload lands. A hint about which source to start on and which
  // of its recognized starters to apply, honored only when both are in the
  // lists just built for this caller; the save is still the guarded POST.
  const params = await searchParams;
  const wanted = sources.find((s) => s.id === params.source);
  const template = wanted?.recognized.find((t) => t.id === params.template);
  const initial = wanted
    ? { sourceId: wanted.id, ...(template ? { templateId: template.id } : {}) }
    : undefined;

  return (
    <NewDashboardClient
      sources={sources}
      initial={initial}
      // Per workspace: each may have its own model, or the caller theirs (#331).
      models={await effectiveModels(identity, workspaces)}
      canManageSources={authorizedWorkspaces(identity, "source:manage").length > 0}
    />
  );
}
