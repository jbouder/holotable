import { can } from "@/lib/auth/authorize";
import type { Identity } from "@/lib/auth/claims";
import { getDashboardTitles } from "@/lib/db/repo";
import { type LinkTargets, linkTargetIds } from "@/lib/drilldown";
import type { Dashboard } from "@/lib/ir";

/**
 * The targets of a dashboard's links that this viewer may follow (#372): each
 * one exists, is not deleted, is in the SAME workspace as the dashboard the
 * link is on, and the viewer may view. Anything else is left out, and the
 * browser shows it disabled rather than as an href.
 *
 * Same-workspace is the rule even when the viewer could open a dashboard
 * elsewhere, like a variable's query source. Nothing about the decision comes
 * from the spec: the ids are only candidates, and `can()` is asked on every
 * page load.
 */
export async function resolveLinkTargets(input: {
  identity: Identity;
  workspaceId: string;
  spec: Pick<Dashboard, "panels">;
  /** Injected for tests; the repo's lookup by default. */
  load?: typeof getDashboardTitles;
}): Promise<LinkTargets> {
  const ids = linkTargetIds(input.spec);
  if (ids.length === 0) return {};
  if (!can(input.identity, "dashboard:view", { workspaceId: input.workspaceId }))
    return {};
  const found = await (input.load ?? getDashboardTitles)(input.workspaceId, ids);
  const targets: LinkTargets = {};
  for (const id of ids) {
    const title = found.get(id);
    if (title !== undefined) targets[id] = { title };
  }
  return targets;
}
