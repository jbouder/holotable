import Link from "next/link";
import { notFound } from "next/navigation";
import { Download, LayoutTemplate, Pencil, Tag } from "lucide-react";
import { getIdentity } from "@/lib/auth/authorize";
import { can } from "@/lib/auth/authorize";
import { getDashboardById } from "@/lib/db/repo";
import { config } from "@/lib/config";
import { SignIn } from "@/components/sign-in";
import { LiveDashboard } from "@/components/dashboard/LiveDashboard";
import { DashboardChat } from "@/components/dashboard/DashboardChat";
import { DeleteDashboardButton } from "@/components/dashboard/delete-dashboard-button";
import { RecordDashboardVisit } from "@/components/dashboard/RecordDashboardVisit";
import { SaveAsTemplate } from "@/components/templates/SaveAsTemplate";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { dashboardListHref, EMPTY_QUERY } from "@/lib/dashboard-list";
import { chatSuggestions } from "@/lib/chat-history";
import { rangeFromParams } from "@/lib/time-range";

export const dynamic = "force-dynamic";

export default async function DashboardViewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const identity = await getIdentity();
  if (!identity) return <SignIn />;

  const { id } = await params;
  const query = await searchParams;
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
        // A shared link carries the window it was shared for. It is parsed
        // against the IR here and falls back to the dashboard's own range, so
        // a mangled `?from=` opens the dashboard rather than an error — and
        // the stream route re-validates and re-resolves it regardless.
        initialTimeRange={rangeFromParams(query, dashboard.spec.timeRange)}
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
            {/*
              The description is row metadata (#119), so it sits beside the
              title rather than in the spec line below it — that line describes
              what the server is executing, and prose is not part of that.
            */}
            {dashboard.description && (
              <p className="mt-1 max-w-3xl text-sm text-muted">{dashboard.description}</p>
            )}
            <p className="mt-1 text-xs text-muted">
              {dashboard.workspaceId} · v{dashboard.version} · refresh{" "}
              {Math.round(dashboard.spec.refreshIntervalMs / 1000)}s ·{" "}
              {dashboard.spec.timeRange.from} → {dashboard.spec.timeRange.to}
            </p>
            {dashboard.tags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {dashboard.tags.map((tag) => (
                  <Link
                    key={tag}
                    href={dashboardListHref({ ...EMPTY_QUERY, tags: [tag] })}
                    className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-primary/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    <Tag className="h-2.5 w-2.5" aria-hidden /> {tag}
                  </Link>
                ))}
              </div>
            )}
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

      <RecordDashboardVisit dashboardId={id} />
      {/*
        The chips are derived from the spec here rather than in the browser so
        the derivation has one home and no model call; the panel projection is
        what the citations match against, and carries nothing the grid below
        does not already render.
      */}
      <DashboardChat
        dashboardId={id}
        dashboardTitle={dashboard.spec.title}
        panels={dashboard.spec.panels.map((p) => ({ title: p.title, query: p.query }))}
        suggestions={chatSuggestions(dashboard.spec)}
      />
    </div>
  );
}
