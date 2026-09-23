import { notFound } from "next/navigation";
import { Building2 } from "lucide-react";
import { authorizedWorkspaces, can, getIdentity } from "@/lib/auth/authorize";
import { accessibleWorkspaces } from "@/lib/auth/claims";
import { config } from "@/lib/config";
import { knownWorkspaceIds, listWorkspaceLimits, usageForDay } from "@/lib/db/repo";
import { utcDay } from "@/lib/limits/budget";
import { sectionVisible, settingsSection } from "@/lib/settings";
import { workspaceLimitsView } from "@/lib/workspace-limits";
import { SignIn } from "@/components/sign-in";
import { SettingsSectionPage } from "@/components/settings/section";
import { WorkspaceLimitsCard } from "@/components/settings/workspace-limits-card";
import { EmptyState } from "@/components/ui/empty-state";

export const dynamic = "force-dynamic";

const fmt = new Intl.NumberFormat("en-US");

function defaultsLine(
  defaults: { ratePerMinute: number; dailyTokenBudget: number },
  platformAdmin: boolean,
): string {
  const budget =
    defaults.dailyTokenBudget > 0
      ? `${fmt.format(defaults.dailyTokenBudget)} tokens a day`
      : "no daily token budget";
  const rate =
    defaults.ratePerMinute > 0
      ? `${fmt.format(defaults.ratePerMinute)} model requests a minute per person`
      : "no rate limit";
  const who = platformAdmin
    ? "Overrides apply to one workspace and take effect on its next model call."
    : "Only a platform admin can change a workspace's limits.";
  return `Defaults for every workspace: ${budget} and ${rate}. ${who}`;
}

/**
 * AI usage and limits per workspace (#218).
 *
 * Which workspaces: a source-admin sees the ones they hold `source:manage`
 * in, from their own claims. A platform admin's bypass covers every
 * workspace, so they see every one the database has seen, plus their own.
 * Who may edit: whoever `can()` grants `workspace:limits`, which is only a
 * platform admin. The route re-checks; the form's absence is not the gate.
 */
export default async function WorkspacesSettings() {
  const identity = await getIdentity();
  if (!identity) return <SignIn />;
  const section = settingsSection("workspaces");
  if (!sectionVisible(section, identity)) notFound();

  const ids = identity.platformAdmin
    ? [
        ...new Set([...(await knownWorkspaceIds()), ...accessibleWorkspaces(identity)]),
      ].sort()
    : authorizedWorkspaces(identity, "source:manage");

  const now = new Date();
  const defaults = {
    ratePerMinute: config.llmRatePerMinute,
    dailyTokenBudget: config.llmDailyTokenBudget,
  };
  const [overrides, usage] = await Promise.all([
    listWorkspaceLimits(ids),
    usageForDay(ids, utcDay(now)),
  ]);

  return (
    <SettingsSectionPage section={section}>
      <p className="text-sm text-muted">
        {defaultsLine(defaults, identity.platformAdmin)}
      </p>
      {ids.length === 0 ? (
        <EmptyState
          icon={<Building2 className="h-6 w-6" />}
          title="No workspaces yet"
          description="Workspaces appear here once they have a data source, a dashboard or recorded model usage."
        />
      ) : (
        ids.map((workspaceId) => (
          <WorkspaceLimitsCard
            key={workspaceId}
            canEdit={can(identity, "workspace:limits", { workspaceId })}
            initial={workspaceLimitsView({
              workspaceId,
              defaults,
              overrides: overrides.get(workspaceId) ?? null,
              usage: usage.get(workspaceId) ?? null,
              now,
            })}
          />
        ))
      )}
    </SettingsSectionPage>
  );
}
