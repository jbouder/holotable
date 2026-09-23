import { type Action, can } from "@/lib/auth/authorize";
import {
  accessibleWorkspaces,
  parseGroups,
  type Identity,
  WORKSPACE_ROLES,
  type WorkspaceRole,
} from "@/lib/auth/claims";

/**
 * What a signed-in person can learn about themselves (#208, #211).
 *
 * `GET /api/me` answers with {@link accountSummary}, and the account settings
 * page renders the same object, so the two cannot disagree. Everything in it
 * comes from the caller's own validated identity: there is no parameter that
 * could point it at someone else, and no workspace appears that the session's
 * groups did not name.
 */

export interface AccountWorkspace {
  id: string;
  role: WorkspaceRole;
}

export interface AccountSummary {
  sub: string;
  displayName: string | null;
  email: string | null;
  platformAdmin: boolean;
  workspaces: AccountWorkspace[];
}

export function accountSummary(identity: Identity): AccountSummary {
  return {
    sub: identity.sub,
    displayName: identity.displayName ?? null,
    email: identity.email ?? null,
    platformAdmin: identity.platformAdmin,
    workspaces: accessibleWorkspaces(identity).map((id) => ({
      id,
      role: identity.workspaces[id] as WorkspaceRole,
    })),
  };
}

/**
 * Plain-language capabilities, one per way {@link can} can say yes.
 *
 * `dashboard:delete` appears twice because the rule has two arms: anyone who
 * can view a workspace may delete a dashboard they own, and a source-admin may
 * delete any. `own` asks `can()` with the probe's own subject as owner.
 */
export const CAPABILITIES: readonly { action: Action; own?: boolean; label: string }[] = [
  { action: "dashboard:view", label: "View dashboards" },
  { action: "source:use", label: "Query data sources from dashboards and Explore" },
  { action: "dashboard:create", label: "Create dashboards" },
  { action: "dashboard:update", label: "Edit dashboards" },
  { action: "dashboard:generate", label: "Generate dashboards and panels with AI" },
  { action: "dashboard:delete", own: true, label: "Delete dashboards you created" },
  { action: "dashboard:delete", label: "Delete any dashboard" },
  { action: "source:manage", label: "Add, change and remove data sources" },
];

const PROBE_WORKSPACE = "probe";
const PROBE_SUB = "probe-user";

/**
 * What a role allows, decided by asking {@link can} about a synthetic identity
 * that holds exactly that role. Nothing here restates a rule.
 */
export function roleCapabilities(role: WorkspaceRole): string[] {
  const probe = parseGroups(PROBE_SUB, [`/workspaces/${PROBE_WORKSPACE}/${role}`]);
  return CAPABILITIES.filter(({ action, own }) =>
    can(probe, action, {
      workspaceId: PROBE_WORKSPACE,
      ownerSub: own ? PROBE_SUB : "someone-else",
    }),
  ).map(({ label }) => label);
}

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  viewer: "Viewer",
  editor: "Editor",
  "source-admin": "Source admin",
};

/** Every role, lowest first, with what it allows. */
export function roleGuide(): { role: WorkspaceRole; label: string; allows: string[] }[] {
  return WORKSPACE_ROLES.map((role) => ({
    role,
    label: ROLE_LABELS[role],
    allows: roleCapabilities(role),
  }));
}
