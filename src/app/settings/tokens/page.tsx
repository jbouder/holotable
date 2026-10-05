import { notFound } from "next/navigation";
import { KeyRound } from "lucide-react";
import { authorizedWorkspaces, getIdentity } from "@/lib/auth/authorize";
import { accessibleWorkspaces } from "@/lib/auth/claims";
import { config } from "@/lib/config";
import { knownWorkspaceIds } from "@/lib/db/repo";
import { sectionVisible, settingsSection } from "@/lib/settings";
import { SignIn } from "@/components/sign-in";
import { SettingsSectionPage } from "@/components/settings/section";
import { ApiTokensCard } from "@/components/settings/api-tokens-card";
import { EmptyState } from "@/components/ui/empty-state";

export const dynamic = "force-dynamic";

/**
 * Service-account API tokens per workspace (#288), for whoever holds
 * `source:manage` there; a platform admin sees every workspace the database
 * has seen. The routes behind the card re-check, so the page's absence is
 * not the gate.
 */
export default async function TokensSettings() {
  const identity = await getIdentity();
  if (!identity) return <SignIn />;
  const section = settingsSection("tokens");
  if (!sectionVisible(section, identity)) notFound();

  const ids = identity.platformAdmin
    ? [
        ...new Set([...(await knownWorkspaceIds()), ...accessibleWorkspaces(identity)]),
      ].sort()
    : authorizedWorkspaces(identity, "source:manage");

  return (
    <SettingsSectionPage section={section}>
      <p className="text-sm text-muted">
        A token acts in one workspace as a viewer or an editor, never as an admin, and
        expires within {config.apiTokenMaxDays} days. Send it as{" "}
        <code>Authorization: Bearer ht_…</code>. It is shown once, when it is created.
      </p>
      {ids.length === 0 ? (
        <EmptyState
          icon={<KeyRound className="h-6 w-6" />}
          title="No workspaces yet"
          description="Workspaces appear here once they have a data source or a dashboard."
        />
      ) : (
        ids.map((workspaceId) => (
          <ApiTokensCard
            key={workspaceId}
            workspaceId={workspaceId}
            maxDays={config.apiTokenMaxDays}
          />
        ))
      )}
    </SettingsSectionPage>
  );
}
