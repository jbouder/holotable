import Link from "next/link";
import { cookies } from "next/headers";
import { Plus } from "lucide-react";
import { authorizedWorkspaces, getIdentity } from "@/lib/auth/authorize";
import { accessibleWorkspaces, type Identity } from "@/lib/auth/claims";
import { listDashboards, listSources } from "@/lib/db/repo";
import { catalogHealth } from "@/lib/catalog/health";
import { onboardingState } from "@/lib/onboarding";
import {
  HOW_IT_WORKS_DISMISSED_COOKIE,
  isDismissed,
  SETUP_DISMISSED_COOKIE,
} from "@/lib/dismissals";
import type { ImportTarget } from "@/lib/dashboard-export";
import { SignIn } from "@/components/sign-in";
import { FirstRun } from "@/components/onboarding/first-run";
import { ImportDashboard } from "./import-dashboard";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function DashboardsPage() {
  const identity = await getIdentity();
  if (!identity) return <SignIn />;

  const workspaces = accessibleWorkspaces(identity);
  const lists = await Promise.all(workspaces.map((w) => listDashboards(w)));
  const dashboards = lists.flat();
  const editable = authorizedWorkspaces(identity, "dashboard:create");
  const canCreate = editable.length > 0;

  // The import dialog needs to know which sources each workspace offers, and
  // it needs it before the user picks a workspace. Projecting to an id and a
  // name here is what keeps `listSources` — which returns hosts, ports and the
  // whole catalog — from reaching the browser.
  const importTargets: ImportTarget[] = await Promise.all(
    editable.map(async (workspaceId) => ({
      workspaceId,
      sources: (await listSources(workspaceId)).map((s) => ({ id: s.id, name: s.name })),
    })),
  );

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Dashboards</h1>
        {canCreate && (
          <div className="flex items-center gap-2">
            <ImportDashboard targets={importTargets} />
            <Link href="/dashboards/new">
              <Button>
                <Plus className="h-4 w-4" /> New dashboard
              </Button>
            </Link>
          </div>
        )}
      </div>

      {dashboards.length === 0 ? (
        <FirstRunSection identity={identity} workspaces={workspaces} />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {dashboards.map((d) => (
            <Link key={d.id} href={`/dashboards/${d.id}`} className="group">
              <Card className="h-full transition-colors group-hover:border-foreground/40">
                <CardContent className="flex h-full flex-col gap-2">
                  <div className="font-medium leading-snug">{d.title}</div>
                  <div className="mt-auto flex flex-col gap-0.5 text-xs text-muted">
                    <span>
                      {d.workspaceId} · v{d.version}
                    </span>
                    <span>updated {new Date(d.updatedAt).toLocaleString()}</span>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * An empty dashboard list is the one place a new install is guaranteed to
 * land, so it is where the guided flow lives rather than on a route of its own
 * that nothing would send anyone to.
 *
 * The sources are read here only to decide two booleans. The catalog — table
 * and column names from a database the reader may not administer — is reduced
 * to a health verdict on the server and never reaches the browser.
 */
async function FirstRunSection({
  identity,
  workspaces,
}: {
  identity: Identity;
  workspaces: string[];
}) {
  const sourceLists = await Promise.all(workspaces.map((w) => listSources(w)));
  const jar = await cookies();

  const state = onboardingState({
    sources: sourceLists.flat().map((source) => ({ catalog: catalogHealth(source) })),
    // This branch is only rendered when the list is empty, but the state is
    // computed from the count rather than from that fact so the module stays
    // true away from this call site.
    dashboardCount: 0,
    canManageSources: authorizedWorkspaces(identity, "source:manage").length > 0,
    canCreateDashboards: authorizedWorkspaces(identity, "dashboard:create").length > 0,
  });

  return (
    <FirstRun
      state={state}
      dismissed={isDismissed(jar.get(SETUP_DISMISSED_COOKIE)?.value)}
      howItWorksDismissed={isDismissed(jar.get(HOW_IT_WORKS_DISMISSED_COOKIE)?.value)}
    />
  );
}
