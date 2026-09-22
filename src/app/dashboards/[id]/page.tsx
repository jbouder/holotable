import Link from "next/link";
import { notFound } from "next/navigation";
import { Download, LayoutTemplate, Pencil } from "lucide-react";
import { getIdentity } from "@/lib/auth/authorize";
import { can } from "@/lib/auth/authorize";
import { getDashboardById } from "@/lib/db/repo";
import { config } from "@/lib/config";
import { SignIn } from "@/components/sign-in";
import { LiveDashboard } from "@/components/dashboard/LiveDashboard";
import { DashboardChat } from "@/components/dashboard/DashboardChat";
import { DeleteDashboardButton } from "@/components/dashboard/delete-dashboard-button";
import { SaveAsTemplate } from "@/components/templates/SaveAsTemplate";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export const dynamic = "force-dynamic";

export default async function DashboardViewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const identity = await getIdentity();
  if (!identity) return <SignIn />;

  const { id } = await params;
  const dashboard = await getDashboardById(id);
  if (!dashboard) notFound();

  if (!can(identity, "dashboard:view", { workspaceId: dashboard.workspaceId })) {
    notFound();
  }

  const canEdit = can(identity, "dashboard:update", {
    workspaceId: dashboard.workspaceId,
  });

  // Saving a template writes to this workspace, so it is gated on the same
  // `dashboard:create` the API checks rather than on being able to edit THIS
  // dashboard -- the two happen to coincide today and need not tomorrow.
  const canSaveTemplate = can(identity, "dashboard:create", {
    workspaceId: dashboard.workspaceId,
  });

  const canDelete = can(identity, "dashboard:delete", {
    workspaceId: dashboard.workspaceId,
    ownerSub: dashboard.createdBy,
  });

  return (
    <div>
      <LiveDashboard
        dashboardId={id}
        spec={dashboard.spec}
        maxWindowPoints={config.maxWindowPoints}
        // A saved dashboard with no panels is reachable — an import trimmed to
        // nothing, or every panel deleted in the editor — and used to render as
        // a header over blank space with a live badge above it.
        empty={
          <EmptyState
            icon={<LayoutTemplate className="h-6 w-6" />}
            title="This dashboard has no panels"
            description={
              canEdit
                ? "Open the editor and describe the panel you want; the model writes the spec and the server runs the query."
                : "Nothing has been added to it yet. An editor can add panels from the dashboard editor."
            }
            action={
              canEdit ? (
                <Link href={`/dashboards/${id}/edit`}>
                  <Button>Add a panel</Button>
                </Link>
              ) : undefined
            }
          />
        }
        header={
          <div>
            <h1 className="text-2xl font-semibold">{dashboard.spec.title}</h1>
            <p className="text-xs text-muted">
              {dashboard.workspaceId} · v{dashboard.version} · refresh{" "}
              {Math.round(dashboard.spec.refreshIntervalMs / 1000)}s ·{" "}
              {dashboard.spec.timeRange.from} → {dashboard.spec.timeRange.to}
            </p>
          </div>
        }
        actions={
          <>
            {/*
              A plain link, not a button with a fetch behind it: the route
              answers with a `Content-Disposition`, so the browser saves the
              file itself and this page ships no JavaScript for it.
            */}
            <a href={`/api/dashboards/${id}/export`} download>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted hover:text-foreground"
              >
                <Download className="h-4 w-4" /> Export
              </Button>
            </a>
            {canSaveTemplate && (
              <SaveAsTemplate
                workspaceId={dashboard.workspaceId}
                defaultName={dashboard.spec.title}
                subject={{ kind: "dashboard", dashboard: dashboard.spec }}
                variant="ghost"
              />
            )}
            {canEdit && (
              <Link href={`/dashboards/${id}/edit`}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted hover:text-foreground"
                >
                  <Pencil className="h-4 w-4" /> Edit
                </Button>
              </Link>
            )}
            {canDelete && (
              <DeleteDashboardButton dashboardId={id} title={dashboard.spec.title} />
            )}
          </>
        }
      />

      <DashboardChat dashboardId={id} dashboardTitle={dashboard.spec.title} />
    </div>
  );
}
