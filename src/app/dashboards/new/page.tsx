import { can, getIdentity } from "@/lib/auth/authorize";
import { accessibleWorkspaces, hasWorkspaceRole } from "@/lib/auth/claims";
import { listSources } from "@/lib/db/repo";
import { catalogHealth } from "@/lib/catalog/health";
import { config } from "@/lib/config";
import { SignIn } from "@/components/sign-in";
import { NewDashboardClient } from "./new-client";

export const dynamic = "force-dynamic";

export default async function NewDashboardPage() {
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
    canRefresh: can(identity, "source:manage", { workspaceId: s.workspaceId }),
  }));

  return <NewDashboardClient sources={sources} model={config.aiModel} />;
}
