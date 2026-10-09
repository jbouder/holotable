import { can } from "@/lib/auth/authorize";
import type { Identity } from "@/lib/auth/claims";
import { listLinkableDashboards } from "@/lib/db/repo";
import { PROMPT_DASHBOARDS_MAX, type PromptDashboard } from "@/lib/ai/prompt";

/**
 * The dashboards a generation is told it may link to (#375): those in the
 * workspace the generation's sources belong to, and only when the caller may
 * view that workspace, so a model is never told about, and cannot link to, a
 * dashboard its caller could not open. The one being edited is marked, so
 * the model links to it as a self link.
 *
 * Advisory like the workspace prompt: if the list cannot be read, the
 * generation runs with an empty one (self links only) rather than failing.
 */
export async function promptDashboards(input: {
  identity: Identity;
  workspaceId: string;
  /** The dashboard being edited, if any. */
  currentId?: string;
  /** Injected for tests; the repo's read by default. */
  load?: typeof listLinkableDashboards;
}): Promise<PromptDashboard[]> {
  if (!can(input.identity, "dashboard:view", { workspaceId: input.workspaceId }))
    return [];
  const rows = await (input.load ?? listLinkableDashboards)(
    input.workspaceId,
    PROMPT_DASHBOARDS_MAX,
  ).catch(() => []);
  return rows.map((d) => ({
    ...d,
    ...(d.id === input.currentId ? { current: true } : {}),
  }));
}
