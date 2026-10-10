import { notFound } from "next/navigation";
import { isSqlSource, sourceKind } from "@/lib/sources/registry";
import { getIdentity, can } from "@/lib/auth/authorize";
import { effectiveModel } from "@/lib/ai/model-resolution";
import { getDashboardById, listDashboardTags, listSources } from "@/lib/db/repo";
import { SignIn } from "@/components/sign-in";
import { EditDashboardClient } from "./edit-client";

export const dynamic = "force-dynamic";

export default async function EditDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /** `?panel=` preselects a panel — how Chat hands off an added panel. */
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

  // The editor completes table and column names from the catalog, so the
  // catalog crosses to the client — projected through `sourceCatalog`, which
  // leaves the host, port, database and `secret_ref` on this side of the wire.
  // Every kind's (#388): a SQL source's tables and columns, a Prometheus
  // source's metrics and labels, each through its kind's own projection, so
  // no URL, host or credential crosses. A SQL source without its credential
  // reference cannot run, and is not offered.
  const sources = (await listSources(dashboard.workspaceId))
    .filter((s) => sourceKind(s.config).language !== "sql" || isSqlSource(s))
    .map((s) => ({
      id: s.id,
      name: s.name,
      workspaceId: s.workspaceId,
      kind: s.config.kind,
      catalog: sourceKind(s.config).catalog(s.config),
    }));

  // Which model a panel edit here uses: the editor's own, the workspace's or
  // the server's (#331).
  const model = await effectiveModel({ identity, workspaceId: dashboard.workspaceId });

  const tagSuggestions = (await listDashboardTags(dashboard.workspaceId)).map(
    (t) => t.tag,
  );

  return (
    <EditDashboardClient
      dashboardId={id}
      workspaceId={dashboard.workspaceId}
      initialSpec={dashboard.spec}
      initialPanelId={panel}
      initialVersion={dashboard.version}
      updatedAt={dashboard.updatedAt}
      // Scopes draft autosave to this viewer: `localStorage` is per browser,
      // not per session, so two people on one machine must not be offered each
      // other's unsaved work (#118).
      userSub={identity.sub}
      sources={sources}
      // Row metadata, handed in separately from the spec because that is what
      // it is: editing it does not make the editor dirty and does not append a
      // version (#119).
      metadata={{ description: dashboard.description, tags: dashboard.tags }}
      tagSuggestions={tagSuggestions}
      model={model.model}
      aiUnavailable={model.unavailable}
    />
  );
}
