import { getIdentity } from "@/lib/auth/authorize";
import { accessibleWorkspaces, hasWorkspaceRole } from "@/lib/auth/claims";
import { config } from "@/lib/config";
import { SignIn } from "@/components/sign-in";
import { SourcesClient } from "./sources-client";

export const dynamic = "force-dynamic";

export default async function DataSourcesPage() {
  const identity = await getIdentity();
  if (!identity) return <SignIn devAuthEnabled={config.devAuthEnabled} />;

  const manageable = accessibleWorkspaces(identity).filter(
    (w) => identity.platformAdmin || hasWorkspaceRole(identity, w, "source-admin"),
  );

  return <SourcesClient workspaces={manageable} />;
}
