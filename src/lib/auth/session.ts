import {
  SignJWT,
  jwtVerify,
  createRemoteJWKSet,
  type JWTPayload,
} from "jose";
import { config } from "@/lib/config";
import { parseGroups, type Identity } from "@/lib/auth/claims";

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
 * Either way we only ever trust the validated `sub` and `groups` claims.
 */

const GROUPS_CLAIM = process.env.OIDC_GROUPS_CLAIM || "groups";

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  const url = process.env.OIDC_JWKS_URL;
  if (!url) return null;
  if (!jwks) jwks = createRemoteJWKSet(new URL(url));
  return jwks;
}

function sessionSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    if (config.isProduction) {
      throw new Error(
        "SESSION_SECRET must be set to a strong (>=32 char) value in production",
      );
    }
    // Dev-only deterministic fallback so local runs work out of the box.
    return new TextEncoder().encode(
      (secret ?? "dev-insecure-session-secret") .padEnd(32, "0"),
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

function identityFromPayload(payload: JWTPayload): Identity | null {
  const sub = typeof payload.sub === "string" ? payload.sub : null;
  if (!sub) return null;
  return parseGroups(sub, extractGroups(payload));
}

/**
 * Verify a raw session token string and return the derived identity, or null.
 */
export async function verifySessionToken(token: string): Promise<Identity | null> {
  if (!token) return null;

  const remote = getJwks();
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
 * Mint a first-party HS256 session token. Used by the OIDC callback (after the
 * Keycloak token is validated) and by the dev-only login route.
 */
export async function signSessionToken(
  sub: string,
  groups: string[],
  ttlSeconds = 60 * 60 * 8,
): Promise<string> {
  return new SignJWT({ [GROUPS_CLAIM]: groups })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer("holotable")
    .setAudience("holotable")
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(sessionSecret());
}
