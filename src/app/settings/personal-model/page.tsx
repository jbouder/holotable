import { notFound } from "next/navigation";
import { authorizedWorkspaces, getIdentity } from "@/lib/auth/authorize";
import { configView, defaultModelDeps, effectiveModel } from "@/lib/ai/model-resolution";
import { sectionVisible, settingsSection } from "@/lib/settings";
import { SignIn } from "@/components/sign-in";
import { PersonalModelCard } from "@/components/settings/personal-model-card";
import { SettingsSectionPage } from "@/components/settings/section";

export const dynamic = "force-dynamic";

/**
 * The signed-in person's own model (#331). Listed with the workspaces they
 * generate in that allow personal keys, and what a generation of theirs in
 * each will use; it is ignored everywhere else.
 */
export default async function PersonalModelSettings() {
  const identity = await getIdentity();
  if (!identity) return <SignIn />;
  const section = settingsSection("personal-model");
  if (!sectionVisible(section, identity)) notFound();

  const deps = defaultModelDeps();
  const stored = await deps.store.user(identity.sub);
  const ids = authorizedWorkspaces(identity, "dashboard:generate");
  const rows = await Promise.all(
    ids.map(async (workspaceId) => ({
      workspaceId,
      record: await deps.store.workspace(workspaceId),
    })),
  );
  const workspaces = await Promise.all(
    rows
      .filter((r) => r.record?.allowPersonalKeys)
      .map(async ({ workspaceId }) => ({
        workspaceId,
        effective: await effectiveModel({ identity, workspaceId }, deps),
      })),
  );

  return (
    <SettingsSectionPage section={section}>
      <p className="text-sm text-muted">
        Bring your own model and key, billed to you. It takes the place of the
        workspace&apos;s model for your own generations, and only in workspaces whose
        source-admins allow it. The key is encrypted at rest and never shown again.
      </p>
      <PersonalModelCard
        initial={stored ? configView(stored) : null}
        workspaces={workspaces}
      />
    </SettingsSectionPage>
  );
}
