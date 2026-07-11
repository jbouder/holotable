import Link from "next/link";
import { Plus } from "lucide-react";
import { getIdentity } from "@/lib/auth/authorize";
import { accessibleWorkspaces, hasWorkspaceRole } from "@/lib/auth/claims";
import { listDashboards } from "@/lib/db/repo";
import { config } from "@/lib/config";
import { SignIn } from "@/components/sign-in";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function DashboardsPage() {
  const identity = await getIdentity();
  if (!identity) return <SignIn devAuthEnabled={config.devAuthEnabled} />;

  const workspaces = accessibleWorkspaces(identity);
  const lists = await Promise.all(workspaces.map((w) => listDashboards(w)));
  const dashboards = lists.flat();
  const canCreate =
    identity.platformAdmin ||
    workspaces.some((w) => hasWorkspaceRole(identity, w, "editor"));

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Dashboards</h1>
        {canCreate && (
          <Link href="/dashboards/new">
            <Button>
              <Plus className="h-4 w-4" /> New dashboard
            </Button>
          </Link>
        )}
      </div>

      {dashboards.length === 0 ? (
        <Card>
          <CardContent className="text-sm text-muted">
            No dashboards yet.{" "}
            {canCreate
              ? "Create one from a natural-language prompt."
              : "Ask an editor to create one."}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {dashboards.map((d) => (
            <Link key={d.id} href={`/dashboards/${d.id}`} className="group">
              <Card className="h-full transition-colors group-hover:border-primary">
                <CardContent className="flex h-full flex-col gap-2">
                  <div className="font-medium leading-snug group-hover:text-primary">
                    {d.title}
                  </div>
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
