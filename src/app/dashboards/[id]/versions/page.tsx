import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { can, getIdentity } from "@/lib/auth/authorize";
import { getDashboardById, listDashboardVersions } from "@/lib/db/repo";
import { VERSION_PAGE_SIZE, VersionNumber } from "@/lib/dashboard-versions";
import { SignIn } from "@/components/sign-in";
import { PageHeader } from "@/components/ui/page-header";
import { ButtonLink } from "@/components/ui/button";
import { VersionHistory } from "./versions-client";

export const dynamic = "force-dynamic";

/**
 * A dashboard's version history (#73): every saved version, what changed
 * between one and the current version, a read-only preview, and Restore for
 * an editor. Viewers see the history too; it holds nothing they could not
 * have seen rendered when it was current.
 */
export default async function DashboardVersionsPage({
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
  const canRestore = can(identity, "dashboard:update", {
    workspaceId: dashboard.workspaceId,
  });

  const page = await listDashboardVersions(id, { limit: VERSION_PAGE_SIZE });

  // `?v=` names the version to open on, so a link can point at one. Absent or
  // malformed, it opens on the one before the current version, because the
  // first thing anyone wants from a history is the latest change.
  const requested = VersionNumber.safeParse(query.v);
  const initialSelected = requested.success
    ? requested.data
    : (page.versions.find((v) => v.version < dashboard.version)?.version ??
      dashboard.version);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Version history"
        description={
          <>
            {dashboard.spec.title} · v{dashboard.version} is current
          </>
        }
        actions={
          <ButtonLink href={`/dashboards/${id}`} variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4" /> Back to dashboard
          </ButtonLink>
        }
      />
      <VersionHistory
        dashboardId={id}
        viewerSub={identity.sub}
        canRestore={canRestore}
        current={{ version: dashboard.version, spec: dashboard.spec }}
        initialPage={page}
        initialSelected={initialSelected}
      />
    </div>
  );
}
