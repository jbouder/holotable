import { notFound } from "next/navigation";
import { getIdentity, can } from "@/lib/auth/authorize";
import { getDashboardById, listSources } from "@/lib/db/repo";
import { SignIn } from "@/components/sign-in";
import { EditDashboardClient } from "./edit-client";

export const dynamic = "force-dynamic";

export default async function EditDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /** `?panel=` preselects a panel — how Explore hands off a saved result. */
  searchParams: Promise<{ panel?: string }>;
}) {
  const identity = await getIdentity();
  if (!identity) return <SignIn />;

  const { id } = await params;
  const { panel } = await searchParams;
  const dashboard = await getDashboardById(id);
  if (!dashboard) notFound();
  if (!can(identity, "dashboard:update", { workspaceId: dashboard.workspaceId })) {
    notFound();
  }

  const sources = (await listSources(dashboard.workspaceId)).map((s) => ({
    id: s.id,
    name: s.name,
    workspaceId: s.workspaceId,
  }));

  return (
    <EditDashboardClient
      dashboardId={id}
      initialSpec={dashboard.spec}
      initialPanelId={panel}
      version={dashboard.version}
      sources={sources}
    />
  );
}
