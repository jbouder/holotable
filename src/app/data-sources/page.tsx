import { getIdentity } from "@/lib/auth/authorize";
import { accessibleWorkspaces, hasWorkspaceRole } from "@/lib/auth/claims";
import { SignIn } from "@/components/sign-in";
import { sourceKindAvailability } from "@/lib/sources/server/registry";
import { SourcesClient } from "./sources-client";

export const dynamic = "force-dynamic";

export default async function DataSourcesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const identity = await getIdentity();
  if (!identity) return <SignIn />;

  // Every workspace the identity can see a source in, the ones it manages
  // first, because the page pins to the first. A viewer gets the page
  // read-only (#123). This only decides what to render: every route behind
  // it checks `can()` again, and the list route itself sends a viewer no
  // connection details.
  const all = accessibleWorkspaces(identity);
  const manageable = all.filter(
    (w) => identity.platformAdmin || hasWorkspaceRole(identity, w, "source-admin"),
  );
  const workspaces = [...manageable, ...all.filter((w) => !manageable.includes(w))];

  // Read on the server so the dialog is open on first paint rather than after
  // hydration. It is a hint about which dialog to show and nothing more — the
  // create path is still the same guarded POST /api/sources.
  const { new: openCreate } = await searchParams;

  // Which kinds this server can hold (#573), for the Add source dialog's
  // picker: read here, with the page, as the other facts it opens with are.
  // Only someone who may add a source is told; the save route checks again.
  const kinds = manageable.length > 0 ? await sourceKindAvailability() : [];

  return (
    <SourcesClient
      workspaces={workspaces}
      manageable={manageable}
      startCreating={openCreate === "1" && manageable.length > 0}
      kinds={kinds}
    />
  );
}
