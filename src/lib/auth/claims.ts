/**
 * Identity & group-claim parsing.
 *
 * Authorization is derived EXCLUSIVELY from the validated identity token's
 * `groups` claim (Keycloak group memberships). It is never derived from a
 * workspace id supplied in a request body/query.
 *
 * Group contract (Keycloak group paths):
 *   /workspaces/{workspaceId}/{viewer|editor|source-admin}  -> per-workspace role
 *   /platform-admins                                         -> global admin
 *
 * When a user has multiple roles in the same workspace, the highest wins.
 */

export const WORKSPACE_ROLES = ["viewer", "editor", "source-admin"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

const ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 1,
  editor: 2,
  "source-admin": 3,
};

export const PLATFORM_ADMIN_GROUP = "/platform-admins";

export interface Identity {
  /** Subject (stable user id). */
  sub: string;
  /** True when the user is a global platform administrator. */
  platformAdmin: boolean;
  /** Highest role held per workspace id. */
  workspaces: Record<string, WorkspaceRole>;
  /**
   * Display-only profile fields (#208). They let the header and the settings
   * page show a person something they recognise as themselves, and nothing
   * else: no authorization decision reads them. `can()` decides from `sub`,
   * `platformAdmin` and `workspaces` alone, and a test holds it to that.
   * Absent when the token did not carry the claim.
   */
  displayName?: string;
  email?: string;
}

/** The display-only part of an {@link Identity}. */
export type Profile = Pick<Identity, "displayName" | "email">;

/** Longer than any real name or address, short enough to keep a cookie small. */
const PROFILE_MAX_LENGTH = 254;

function profileString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Control characters have no business in a name, and stripping them keeps a
  // claim from smuggling line breaks into the header or a log line.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean ? clean.slice(0, PROFILE_MAX_LENGTH) : undefined;
}

/**
 * Read the display-only profile from a validated token's claims: OIDC's
 * standard `name` (falling back to `preferred_username`) and `email`. The
 * first-party session token writes the same claim names back, so one reader
 * serves both.
 */
export function profileFromClaims(claims: Readonly<Record<string, unknown>>): Profile {
  const displayName =
    profileString(claims.name) ?? profileString(claims.preferred_username);
  const email = profileString(claims.email);
  return {
    ...(displayName ? { displayName } : {}),
    ...(email ? { email } : {}),
  };
}

function isWorkspaceRole(value: string): value is WorkspaceRole {
  return (WORKSPACE_ROLES as readonly string[]).includes(value);
}

/**
 * Parse raw group strings into a normalized {@link Identity} role map.
 * Unknown/malformed groups are ignored (fail-closed: no role granted).
 */
export function parseGroups(sub: string, groups: readonly string[]): Identity {
  let platformAdmin = false;
  const workspaces: Record<string, WorkspaceRole> = {};

  for (const raw of groups ?? []) {
    if (typeof raw !== "string") continue;
    const path = raw.startsWith("/") ? raw : `/${raw}`;
    const segments = path.split("/").filter(Boolean);

    if (segments.length === 1 && `/${segments[0]}` === PLATFORM_ADMIN_GROUP) {
      platformAdmin = true;
      continue;
    }

    // /workspaces/{workspaceId}/{role}
    if (segments.length === 3 && segments[0] === "workspaces") {
      const workspaceId = segments[1];
      const role = segments[2];
      if (!workspaceId || !isWorkspaceRole(role)) continue;
      const current = workspaces[workspaceId];
      if (!current || ROLE_RANK[role] > ROLE_RANK[current]) {
        workspaces[workspaceId] = role;
      }
    }
  }

  return { sub, platformAdmin, workspaces };
}

/** Does the identity hold at least `min` role in `workspaceId`? */
export function hasWorkspaceRole(
  identity: Identity,
  workspaceId: string,
  min: WorkspaceRole,
): boolean {
  if (identity.platformAdmin) return true;
  const role = identity.workspaces[workspaceId];
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** List every workspace the identity can at least view (plus admin bypass note). */
export function accessibleWorkspaces(identity: Identity): string[] {
  return Object.keys(identity.workspaces).sort();
}
