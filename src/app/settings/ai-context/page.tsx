import { notFound } from "next/navigation";
import { Sparkles } from "lucide-react";
import { authorizedWorkspaces, can, getIdentity } from "@/lib/auth/authorize";
import { accessibleWorkspaces } from "@/lib/auth/claims";
import { knownWorkspaceIds, listSources } from "@/lib/db/repo";
import { pgWorkspacePromptStore } from "@/lib/db/workspace-prompts";
import { sectionVisible, settingsSection } from "@/lib/settings";
import { EMPTY_WORKSPACE_PROMPT } from "@/lib/workspace-prompt";
import { SignIn } from "@/components/sign-in";
import { SettingsSectionPage } from "@/components/settings/section";
import { WorkspacePromptCard } from "@/components/settings/workspace-prompt-card";
import { EmptyState } from "@/components/ui/empty-state";

export const dynamic = "force-dynamic";

/**
 * Per-workspace prompt customization (#66).
 *
 * Which workspaces: every one the identity may generate in, so an editor can
 * read the context and the composed prompt; a platform admin sees every one
 * the database has seen. Who may edit: whoever holds `source:manage` there.
 * The routes re-check both.
 */
export default async function AiContextSettings() {
  const identity = await getIdentity();
  if (!identity) return <SignIn />;
  const section = settingsSection("ai-context");
  if (!sectionVisible(section, identity)) notFound();

  const ids = identity.platformAdmin
    ? [
        ...new Set([...(await knownWorkspaceIds()), ...accessibleWorkspaces(identity)]),
      ].sort()
    : authorizedWorkspaces(identity, "dashboard:generate");

  const cards = await Promise.all(
    ids.map(async (workspaceId) => {
      const [view, sources] = await Promise.all([
        pgWorkspacePromptStore.get(workspaceId),
        listSources(workspaceId),
      ]);
      return {
        workspaceId,
        view: view ?? {
          workspaceId,
          prompt: EMPTY_WORKSPACE_PROMPT,
          updatedBy: null,
          updatedAt: null,
        },
        sources: sources.map((s) => ({ id: s.id, name: s.name })),
      };
    }),
  );

  return (
    <SettingsSectionPage section={section}>
      <p className="text-sm text-muted">
        The model knows each source&apos;s tables and columns and nothing else. Tell it
        what your team means by its words, how your metrics are defined, and how you
        answer the requests you make often. It is added to every dashboard, panel and
        explore generation in the workspace, and it never overrides the SQL or security
        rules.
      </p>
      {cards.length === 0 ? (
        <EmptyState
          icon={<Sparkles className="h-6 w-6" />}
          title="No workspaces yet"
          description="Workspaces appear here once they have a data source or a dashboard."
        />
      ) : (
        cards.map(({ workspaceId, view, sources }) => (
          <WorkspacePromptCard
            key={workspaceId}
            initial={view}
            canEdit={can(identity, "source:manage", { workspaceId })}
            sources={sources}
          />
        ))
      )}
    </SettingsSectionPage>
  );
}
