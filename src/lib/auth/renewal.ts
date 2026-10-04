import { decodeJwt } from "jose";
import type { Identity } from "@/lib/auth/claims";
import { OidcGrantRefused, type TokenSet } from "@/lib/auth/oidc";
import type { TokenProfile } from "@/lib/auth/session";
import {
  hashSessionId,
  newSessionId,
  openRefreshToken,
  sealRefreshToken,
} from "@/lib/auth/refresh-token";
import { log } from "@/lib/log";

/**
 * Session renewal (#27).
 *
 * The session cookie is still a stateless first-party token and every request
 * is still authenticated by verifying it, exactly as before; nothing here is
 * on that path. What changes is what happens near its expiry. When the realm
 * issued a refresh token at sign-in, it is kept server-side (sealed, in
 * `sessions`) and `POST /api/auth/refresh` trades it for a fresh id_token,
 * re-derives the groups from that, and mints a new session token. A removed
 * group therefore stops working at the next renewal, and a session the realm
 * has ended cannot be renewed at all.
 *
 * The database and the realm are passed in, so the rules below are tested
 * without either.
 */

/** A session with nothing to renew it lasts as long as one always has. */
export const UNRENEWABLE_TTL_SECONDS = 8 * 60 * 60;
/** A renewable session token, when the realm gives no refresh lifetime. */
export const RENEWABLE_TTL_SECONDS = 15 * 60;
const MIN_TTL_SECONDS = 60;
/** How long a row lives when the realm says its refresh token has no idle limit. */
const UNBOUNDED_ROW_SECONDS = 7 * 24 * 60 * 60;

/**
 * How long the session token and the stored refresh token each last.
 *
 * The token lives for half of the refresh token's remaining life, so the
 * renewal that replaces it lands well inside the realm's idle timeout (30
 * minutes in a default Keycloak realm) and keeps the realm session alive too.
 * It is also how long a removed group can keep working, at most.
 */
export function sessionLifetimes(refreshExpiresIn: number | undefined): {
  tokenTtl: number;
  rowTtl: number;
} {
  if (refreshExpiresIn === undefined || refreshExpiresIn <= 0) {
    return { tokenTtl: RENEWABLE_TTL_SECONDS, rowTtl: UNBOUNDED_ROW_SECONDS };
  }
  const half = Math.floor(refreshExpiresIn / 2);
  return {
    tokenTtl: Math.min(Math.max(half, MIN_TTL_SECONDS), UNRENEWABLE_TTL_SECONDS),
    rowTtl: refreshExpiresIn,
  };
}

/** The group paths a first-party token carries, rebuilt from a parsed identity. */
export function groupsOf(identity: Identity): string[] {
  const groups = Object.entries(identity.workspaces).map(
    ([ws, role]) => `/workspaces/${ws}/${role}`,
  );
  if (identity.platformAdmin) groups.push("/platform-admins");
  return groups;
}

export interface StoredSession {
  sub: string;
  /** The realm's session id from sign-in, when its id_token carried one. */
  oidcSid: string | null;
  refreshToken: Uint8Array;
  expiresAt: Date;
}

export interface LockedSession {
  /** The row, or null when there is none. */
  row: StoredSession | null;
  update(next: { refreshToken: Buffer; expiresAt: Date }): Promise<void>;
  remove(): Promise<void>;
}

export interface SessionStore {
  create(row: {
    idHash: string;
    sub: string;
    oidcSid: string | null;
    refreshToken: Buffer;
    expiresAt: Date;
  }): Promise<void>;
  /**
   * Run `fn` holding a lock on the row, so two tabs renewing at once take
   * turns: the second reads the refresh token the first was given, which
   * matters to a realm that rotates them.
   */
  withLocked<T>(idHash: string, fn: (session: LockedSession) => Promise<T>): Promise<T>;
  remove(idHash: string): Promise<void>;
}

export interface RenewalDeps {
  store: SessionStore;
  refreshTokens(refreshToken: string): Promise<TokenSet>;
  verifyIdToken(idToken: string): Promise<Identity | null>;
  signSessionToken(
    sub: string,
    groups: string[],
    profile: TokenProfile,
    ttlSeconds: number,
    sid?: string,
  ): Promise<string>;
  now?: () => number;
}

export interface IssuedSession {
  sessionToken: string;
  tokenTtl: number;
  /** When the session token expires, epoch ms; the client renews before it. */
  expiresAt: number;
  /** The session-id cookie to set, when the session can be renewed. */
  renewal?: { sessionId: string; ttl: number };
}

/**
 * The token carries the realm's session id as `sid`, which is what a
 * back-channel logout names (#28).
 */
function mint(
  deps: RenewalDeps,
  identity: Identity,
  tokenTtl: number,
  oidcSid: string | null,
): Promise<string> {
  return deps.signSessionToken(
    identity.sub,
    groupsOf(identity),
    {
      displayName: identity.displayName,
      email: identity.email,
      attributes: identity.attributes,
    },
    tokenTtl,
    oidcSid ?? undefined,
  );
}

function oidcSidOf(idToken: string): string | null {
  try {
    const sid = decodeJwt(idToken).sid;
    return typeof sid === "string" ? sid : null;
  } catch {
    return null;
  }
}

/**
 * Sign-in: the identity the callback verified, and the token set it came in.
 *
 * With no refresh token, or when the row cannot be written, the session is
 * the unrenewable eight hours it has always been. A database that is down at
 * sign-in costs renewal, not the sign-in.
 */
export async function startSession(
  deps: RenewalDeps,
  identity: Identity,
  tokens: TokenSet,
): Promise<IssuedSession> {
  const now = (deps.now ?? Date.now)();
  const oidcSid = oidcSidOf(tokens.id_token);
  if (tokens.refresh_token) {
    const { tokenTtl, rowTtl } = sessionLifetimes(tokens.refresh_expires_in);
    const sessionId = newSessionId();
    try {
      await deps.store.create({
        idHash: hashSessionId(sessionId),
        sub: identity.sub,
        oidcSid,
        refreshToken: sealRefreshToken(tokens.refresh_token),
        expiresAt: new Date(now + rowTtl * 1000),
      });
      return {
        sessionToken: await mint(deps, identity, tokenTtl, oidcSid),
        tokenTtl,
        expiresAt: now + tokenTtl * 1000,
        renewal: { sessionId, ttl: rowTtl },
      };
    } catch (err) {
      log.warn("auth.session.store_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    sessionToken: await mint(deps, identity, UNRENEWABLE_TTL_SECONDS, oidcSid),
    tokenTtl: UNRENEWABLE_TTL_SECONDS,
    expiresAt: now + UNRENEWABLE_TTL_SECONDS * 1000,
  };
}

/**
 * Why a renewal did not happen. `ended`: there is no session to renew — no
 * row, an expired one, or the realm refused the refresh token — so the person
 * must sign in again. `unavailable`: the realm or the database could not be
 * reached, and the same request may work in a moment.
 */
export type RenewFailure = "ended" | "unavailable";

export type RenewOutcome =
  | ({ ok: true } & IssuedSession & { renewal: { sessionId: string; ttl: number } })
  | { ok: false; reason: RenewFailure };

export async function renewSession(
  deps: RenewalDeps,
  sessionId: string,
): Promise<RenewOutcome> {
  const now = (deps.now ?? Date.now)();
  const idHash = hashSessionId(sessionId);
  try {
    return await deps.store.withLocked(idHash, async (session): Promise<RenewOutcome> => {
      const ended = async (why: string): Promise<RenewOutcome> => {
        log.info("auth.session.ended", { why });
        if (session.row) await session.remove();
        return { ok: false, reason: "ended" };
      };

      if (!session.row) return ended("no session");
      if (session.row.expiresAt.getTime() <= now) return ended("expired");
      const refreshToken = openRefreshToken(session.row.refreshToken);
      if (!refreshToken) return ended("unreadable refresh token");

      let tokens: TokenSet;
      try {
        tokens = await deps.refreshTokens(refreshToken);
      } catch (err) {
        if (err instanceof OidcGrantRefused) return ended("refused by the realm");
        throw err;
      }

      const identity = await deps.verifyIdToken(tokens.id_token);
      if (!identity) return ended("id_token did not verify");
      // The realm answered for the person who signed in, or for no one.
      if (identity.sub !== session.row.sub) return ended("subject changed");

      const { tokenTtl, rowTtl } = sessionLifetimes(tokens.refresh_expires_in);
      await session.update({
        // A realm that does not rotate sends none back; the old one stands.
        refreshToken: sealRefreshToken(tokens.refresh_token ?? refreshToken),
        expiresAt: new Date(now + rowTtl * 1000),
      });
      return {
        ok: true,
        sessionToken: await mint(
          deps,
          identity,
          tokenTtl,
          oidcSidOf(tokens.id_token) ?? session.row.oidcSid,
        ),
        tokenTtl,
        expiresAt: now + tokenTtl * 1000,
        renewal: { sessionId, ttl: rowTtl },
      };
    });
  } catch (err) {
    log.warn("auth.session.renew_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: "unavailable" };
  }
}

/** Sign-out: forget the stored refresh token. Best effort; the cookies go regardless. */
export async function endSession(deps: Pick<RenewalDeps, "store">, sessionId: string) {
  try {
    await deps.store.remove(hashSessionId(sessionId));
  } catch (err) {
    log.warn("auth.session.remove_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
