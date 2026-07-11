import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil } from "lucide-react";
import { getIdentity } from "@/lib/auth/authorize";
import { can } from "@/lib/auth/authorize";
import { getDashboardById } from "@/lib/db/repo";
import { config } from "@/lib/config";
import { SignIn } from "@/components/sign-in";
import { LiveDashboard } from "@/components/dashboard/LiveDashboard";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function DashboardViewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const identity = await getIdentity();
  if (!identity) return <SignIn devAuthEnabled={config.devAuthEnabled} />;

  const { id } = await params;
  const dashboard = await getDashboardById(id);
  if (!dashboard) notFound();

  if (!can(identity, "dashboard:view", { workspaceId: dashboard.workspaceId })) {
    notFound();
  }

  const canEdit = can(identity, "dashboard:update", {
    workspaceId: dashboard.workspaceId,
  });

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{dashboard.spec.title}</h1>
          <p className="text-xs text-muted">
            {dashboard.workspaceId} · v{dashboard.version} · refresh{" "}
            {Math.round(dashboard.spec.refreshIntervalMs / 1000)}s ·{" "}
            {dashboard.spec.timeRange.from} → {dashboard.spec.timeRange.to}
          </p>
        </div>
        {canEdit && (
          <Link href={`/dashboards/${id}/edit`}>
            <Button variant="secondary" size="sm">
              <Pencil className="h-4 w-4" /> Edit
            </Button>
          </Link>
        )}
      </div>

      <LiveDashboard
        dashboardId={id}
        spec={dashboard.spec}
        maxWindowPoints={config.maxWindowPoints}
      />
    </div>
  );
}
