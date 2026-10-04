import { SignJWT, jwtVerify, createRemoteJWKSet, decodeJwt, type JWTPayload } from "jose";
import { config } from "@/lib/config";
import {
  attributesFromClaims,
  parseGroups,
  profileFromClaims,
  type Identity,
  type Profile,
} from "@/lib/auth/claims";
import { isRevoked, type TokenRef } from "@/lib/auth/revocation";

/**
 * Session verification.
 *
 * A request is authenticated by a signed JWT carried in the session cookie.
 * Two verification strategies are supported, selected by environment:
 *
 *  1. Keycloak-issued tokens (production): verified against the realm JWKS
 *     (RS256) with issuer + audience checks. Enabled when `OIDC_JWKS_URL` and
 *     `OIDC_ISSUER` are configured.
 *  2. Locally-signed session tokens (HS256 via `SESSION_SECRET`): used by the
 *     OIDC callback to mint a first-party session, and by dev-only login.
 *
 * Either way authorization only ever trusts the validated `sub` and `groups`
 * claims. `name` and `email` are read too, as display-only profile fields, and
 * the claims `ROW_FILTER_CLAIMS` names, which decide which rows a row-filtered
 * source returns (#31) and nothing else.
 */

const GROUPS_CLAIM = process.env.OIDC_GROUPS_CLAIM || "groups";

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
/** The realm's signing keys, or null when `OIDC_JWKS_URL` is not set. */
export function realmJwks() {
  const url = process.env.OIDC_JWKS_URL;
  if (!url) return null;
  if (!jwks) jwks = createRemoteJWKSet(new URL(url));
  return jwks;
}

/**
 * The raw `SESSION_SECRET` bytes. Signs the session token, and is the input
 * key material the refresh-token encryption key is derived from
 * (`src/lib/auth/refresh-token.ts`), under its own HKDF label.
 */
export function sessionSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    if (config.isProduction) {
      throw new Error(
        "SESSION_SECRET must be set to a strong (>=32 char) value in production",
      );
    }
    // Dev-only deterministic fallback so local runs work out of the box.
    return new TextEncoder().encode(
      (secret ?? "dev-insecure-session-secret").padEnd(32, "0"),
    );
  }
  return new TextEncoder().encode(secret);
}

function extractGroups(payload: JWTPayload): string[] {
  const raw = (payload as Record<string, unknown>)[GROUPS_CLAIM];
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === "string");
  if (typeof raw === "string") return raw.split(/[\s,]+/).filter(Boolean);
  return [];
}

function refFromPayload(payload: JWTPayload, sub: string): TokenRef {
  return {
    sub,
    sid: typeof payload.sid === "string" ? payload.sid : null,
    iat: typeof payload.iat === "number" ? payload.iat : 0,
  };
}

function identityFromPayload(payload: JWTPayload): Identity | null {
  const sub = typeof payload.sub === "string" ? payload.sub : null;
  if (!sub) return null;
  // A session the realm ended by back-channel logout (#28) is refused here,
  // on every request, rather than at its expiry.
  if (isRevoked(refFromPayload(payload, sub))) return null;
  const attributes = attributesFromClaims(
    payload as Record<string, unknown>,
    config.rowFilterClaims,
  );
  return {
    ...parseGroups(sub, extractGroups(payload)),
    ...profileFromClaims(payload as Record<string, unknown>),
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
  };
}

/**
 * Verify a raw session token string and return the derived identity, or null.
 */
export async function verifySessionToken(token: string): Promise<Identity | null> {
  if (!token) return null;

  const remote = realmJwks();
  if (remote) {
    try {
      const { payload } = await jwtVerify(token, remote, {
        issuer: process.env.OIDC_ISSUER,
        audience: process.env.OIDC_AUDIENCE || undefined,
      });
      return identityFromPayload(payload);
    } catch {
      // Fall through to first-party session verification below.
    }
  }

  try {
    const { payload } = await jwtVerify(token, sessionSecret(), {
      issuer: "holotable",
      audience: "holotable",
    });
    return identityFromPayload(payload);
  } catch {
    return null;
  }
}

/**
 * What a first-party token carries beside `sub` and the groups: the display
 * profile, and the row-filter attributes read from the realm's token.
 */
export type TokenProfile = Profile & Pick<Identity, "attributes">;

/**
 * Mint a first-party HS256 session token. Used by the OIDC callback, after the
 * Keycloak token is validated. The profile rides along under the standard
 * `name` and `email` claim names, and each row-filter attribute under its own
 * realm claim name, so {@link verifySessionToken} reads them back with the
 * same code it uses for a Keycloak token. `validateConfig` keeps those names
 * clear of the ones set here.
 */
export async function signSessionToken(
  sub: string,
  groups: string[],
  profile: TokenProfile = {},
  ttlSeconds = 60 * 60 * 8,
  /** The realm session id, so a back-channel logout can name this token (#28). */
  sid?: string,
): Promise<string> {
  const claims: JWTPayload = { ...profile.attributes, [GROUPS_CLAIM]: groups };
  if (sid) claims.sid = sid;
  if (profile.displayName) claims.name = profile.displayName;
  if (profile.email) claims.email = profile.email;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer("holotable")
    .setAudience("holotable")
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(sessionSecret());
}

/**
 * When a session token expires, epoch ms, or null. Read WITHOUT verifying: it
 * is only ever used to decide when the browser should renew (#27), after
 * {@link verifySessionToken} has already accepted the same token, and a wrong
 * value can only make a renewal early or late.
 */
export function tokenExpiry(token: string): number | null {
  try {
    const { exp } = decodeJwt(token);
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * What a revocation is matched against, read from a token that has ALREADY
 * been verified (the stream route reads it after `requireIdentity`).
 */
export function tokenRef(token: string): TokenRef | null {
  try {
    const payload = decodeJwt(token);
    return typeof payload.sub === "string" ? refFromPayload(payload, payload.sub) : null;
  } catch {
    return null;
  }
}
