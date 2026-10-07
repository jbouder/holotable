import { notFound } from "next/navigation";
import { Cpu } from "lucide-react";
import { authorizedWorkspaces, getIdentity } from "@/lib/auth/authorize";
import { accessibleWorkspaces } from "@/lib/auth/claims";
import { workspaceModelView } from "@/lib/ai/model-resolution";
import { config } from "@/lib/config";
import { knownWorkspaceIds } from "@/lib/db/repo";
import { sectionVisible, settingsSection } from "@/lib/settings";
import { SignIn } from "@/components/sign-in";
import { SettingsSectionPage } from "@/components/settings/section";
import { WorkspaceModelCard } from "@/components/settings/workspace-model-card";
import { EmptyState } from "@/components/ui/empty-state";

export const dynamic = "force-dynamic";

/**
 * Each workspace's model (#331), for the workspaces the identity holds
 * `source:manage` in; a platform admin sees every one the database has seen.
 * The routes re-check `source:manage`, and refuse in demo mode, where this
 * section is not listed.
 */
export default async function ModelSettings() {
  const identity = await getIdentity();
  if (!identity) return <SignIn />;
  const section = settingsSection("model");
  if (!sectionVisible(section, identity)) notFound();

  const ids = identity.platformAdmin
    ? [
        ...new Set([...(await knownWorkspaceIds()), ...accessibleWorkspaces(identity)]),
      ].sort()
    : authorizedWorkspaces(identity, "source:manage");
  const views = await Promise.all(ids.map((id) => workspaceModelView(id)));

  return (
    <SettingsSectionPage section={section}>
      <p className="text-sm text-muted">
        Without a workspace model, generation uses the server&apos;s
        {config.aiModel ? (
          <>
            , <span className="font-mono">{config.aiModel}</span>
          </>
        ) : null}
        . A workspace model is used for every dashboard, panel, Explore and chat
        generation in the workspace from the next request on. Keys are encrypted at rest
        and never shown again.
      </p>
      {views.length === 0 ? (
        <EmptyState
          icon={<Cpu className="h-6 w-6" />}
          title="No workspaces yet"
          description="Workspaces appear here once they have a data source or a dashboard."
        />
      ) : (
        views.map((view) => (
          <WorkspaceModelCard
            key={view.workspaceId}
            initial={view}
            serverModel={config.aiModel}
          />
        ))
      )}
    </SettingsSectionPage>
  );
}
