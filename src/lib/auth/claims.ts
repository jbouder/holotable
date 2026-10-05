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
   * `platformAdmin`, `workspaces` and a share link's `share` alone, and a test
   * holds it to that.
   * Absent when the token did not carry the claim.
   */
  displayName?: string;
  email?: string;
  /**
   * The realm claims named by `ROW_FILTER_CLAIMS`, as strings (#31). They
   * decide which ROWS a row-filtered source returns to this person, never
   * whether they may act: `can()` does not read them. Absent, or missing a
   * name, when the token did not carry that claim as a single value, and a
   * row-filtered source then refuses rather than serving every row.
   */
  attributes?: Readonly<Record<string, string>>;
  /**
   * Set only for a read-only share link (#65), never for a person: the one
   * dashboard it may view. `can()` reads it before anything else and allows
   * `dashboard:view` on that dashboard and nothing at all besides.
   */
  share?: Readonly<{ shareId: string; dashboardId: string; workspaceId: string }>;
}

/** The display-only part of an {@link Identity}. */
export type Profile = Pick<Identity, "displayName" | "email">;

/* -------------------------------------------------------------------------- */
/* Row-filter attributes (#31)                                                */
/* -------------------------------------------------------------------------- */

/**
 * The claim a source's row filter may always use: the subject, which every
 * identity has, for rows that belong to one person.
 */
export const SUBJECT_CLAIM = "sub";

/**
 * What a configurable claim name may look like: a plain name, or a namespaced
 * one such as `https://example.com/tenant`. Matched against the token's
 * top-level keys exactly, so a dotted name is one key, not a path.
 */
export const CLAIM_NAME = /^[A-Za-z_][A-Za-z0-9_.:/-]{0,127}$/;

/**
 * Claims the first-party session token already uses for itself. Carrying a
 * realm claim under one of these names would overwrite it when the session is
 * minted, so `validateConfig` refuses them in `ROW_FILTER_CLAIMS`.
 */
export const RESERVED_CLAIMS: ReadonlySet<string> = new Set([
  "sub",
  "iss",
  "aud",
  "exp",
  "nbf",
  "iat",
  "jti",
  "sid",
  "azp",
  "typ",
  "nonce",
  "auth_time",
  "at_hash",
  "c_hash",
  "acr",
  "amr",
  "session_state",
  "name",
  "email",
  "preferred_username",
]);

/** `ROW_FILTER_CLAIMS` as names: comma- or whitespace-separated. */
export function splitClaimNames(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).filter(Boolean))];
}

/** Longest attribute value kept. A tenant id is far shorter. */
const ATTRIBUTE_MAX_LENGTH = 256;

function attributeValue(value: unknown): string | undefined {
  // One value or none. A list would make "which tenant?" ambiguous, and an
  // ambiguous answer must not be resolved by picking one.
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a control character is no part of an id
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  if (value.length === 0 || value.length > ATTRIBUTE_MAX_LENGTH) return undefined;
  return value;
}

/**
 * Read the configured row-filter claims from a validated token. A claim that
 * is missing, a list, an object, empty, too long or carries a control
 * character is left out, never coerced: its absence is what makes a filtered
 * source refuse.
 */
export function attributesFromClaims(
  claims: Readonly<Record<string, unknown>>,
  names: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = attributeValue(claims[name]);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** The value `claim` holds for this identity, if any. */
export function claimValue(identity: Identity, claim: string): string | undefined {
  if (claim === SUBJECT_CLAIM) return identity.sub;
  return Object.hasOwn(identity.attributes ?? {}, claim)
    ? identity.attributes?.[claim]
    : undefined;
}

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
