import { getIdentity } from "@/lib/auth/authorize";
import { accessibleWorkspaces, hasWorkspaceRole } from "@/lib/auth/claims";
import { SignIn } from "@/components/sign-in";
import { SourcesClient } from "./sources-client";

export const dynamic = "force-dynamic";

export default async function DataSourcesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const identity = await getIdentity();
  if (!identity) return <SignIn />;

  const manageable = accessibleWorkspaces(identity).filter(
    (w) => identity.platformAdmin || hasWorkspaceRole(identity, w, "source-admin"),
  );

  // Read on the server so the dialog is open on first paint rather than after
  // hydration. It is a hint about which dialog to show and nothing more — the
  // create path is still the same guarded POST /api/sources.
  const { new: openCreate } = await searchParams;

  return <SourcesClient workspaces={manageable} startCreating={openCreate === "1"} />;
}
