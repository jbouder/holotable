import { jwtVerify, type JWTVerifyGetKey } from "jose";

/**
 * The OIDC back-channel logout token (#28), checked as OpenID Connect
 * Back-Channel Logout 1.0 §2.6 requires.
 *
 * Keycloak POSTs it to `/api/auth/backchannel-logout` when a realm session
 * ends: an admin signed someone out, the person signed out of another app on
 * the same realm, or the session was revoked. The endpoint is unauthenticated
 * by nature — the realm is calling, not a browser — so this verification is
 * all that stands between an arbitrary POST and signing someone out. It is
 * therefore strict, and anything it is unsure of is refused.
 */

export const BACKCHANNEL_LOGOUT_EVENT =
  "http://schemas.openid.net/event/backchannel-logout";

/** A logout token older than this is refused, which bounds any replay. */
const MAX_TOKEN_AGE = "5 minutes";

export interface LogoutClaims {
  sub?: string;
  sid?: string;
}

export interface LogoutTokenOptions {
  issuer: string;
  /** The client id: a logout token is addressed to one client. */
  audience: string;
}

/**
 * The `sub` and/or `sid` the token ends, or null when it is not a valid logout
 * token for this client. Signature (the realm's keys only; `alg: none` cannot
 * pass), issuer, audience and age are checked by `jwtVerify`; the rest are the
 * logout-specific rules.
 */
export async function verifyLogoutToken(
  token: string,
  keys: JWTVerifyGetKey,
  opts: LogoutTokenOptions,
): Promise<LogoutClaims | null> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      issuer: opts.issuer,
      audience: opts.audience,
      maxTokenAge: MAX_TOKEN_AGE,
      requiredClaims: ["iat"],
    }));
  } catch {
    return null;
  }

  // It must say it is a logout, and nothing else may pass for one: an id_token
  // or access token from the same realm is signed by the same keys.
  const events = payload.events;
  if (typeof events !== "object" || events === null || Array.isArray(events)) return null;
  const event = (events as Record<string, unknown>)[BACKCHANNEL_LOGOUT_EVENT];
  if (typeof event !== "object" || event === null) return null;
  // §2.4: a logout token never carries a nonce; an id_token does.
  if ("nonce" in payload) return null;

  const claims: LogoutClaims = {};
  if (typeof payload.sub === "string" && payload.sub !== "") claims.sub = payload.sub;
  if (typeof payload.sid === "string" && payload.sid !== "") claims.sid = payload.sid;
  return claims.sub || claims.sid ? claims : null;
}
