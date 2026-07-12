import { getIdentity } from "@/lib/auth/authorize";
import { accessibleWorkspaces, hasWorkspaceRole } from "@/lib/auth/claims";
import { listSources } from "@/lib/db/repo";
import { config } from "@/lib/config";
import { SignIn } from "@/components/sign-in";
import { ExploreClient } from "./explore-client";

export const dynamic = "force-dynamic";

export default async function ExplorePage() {
  const identity = await getIdentity();
  if (!identity) return <SignIn devAuthEnabled={config.devAuthEnabled} />;

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
  }));

  return <ExploreClient sources={sources} model={config.aiModel} />;
}
