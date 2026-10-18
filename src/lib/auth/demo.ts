import { randomBytes } from "node:crypto";
import type { MintingMode } from "@/lib/config";
import { safeNextPath } from "@/lib/auth/next-path";
import { signSessionToken, verifySessionToken } from "@/lib/auth/session";

/**
 * Session minting for the two modes without a login (#251, #600), the one
 * exception to "Keycloak is the only way in", and only reachable when
 * `AUTH_MODE` is `demo` or `local`.
 *
 * The exception lives in *minting*, never in *verification*. A minted session
 * is an ordinary first-party HS256 token: `verifySessionToken`, the claims
 * parser and `can()` treat it exactly like one minted by the OIDC callback, so
 * there is no second code path deciding who may do what. What keeps it safe is
 * `validateConfig`, which refuses to boot either mode beside a real realm, or
 * with groups that reach platform admin (and, in demo mode, source-admin).
 *
 * The two modes differ only in who the session names. A demo visitor is a
 * fresh `demo:<random>` subject each, so strangers on a public demo keep their
 * own preferences and chat. The local owner is one constant subject, so the
 * one person on their own machine keeps theirs across sessions and restarts.
 */

/** Prefix on every demo subject, so a log line or a row is recognisably one. */
export const DEMO_SUB_PREFIX = "demo:";
export const DEMO_DISPLAY_NAME = "Demo visitor";

/** The one subject every local-mode session names (#600). */
export const LOCAL_SUBJECT = "local:owner";
/** How the account page and the audit log name the local owner. */
export const LOCAL_DISPLAY_NAME = "Local owner";

/**
 * A fresh subject per visitor. Preferences, favorites, chat history and the
 * per-user model rate bucket are keyed by `sub`, so each visitor gets their
 * own; dashboards are workspace-scoped and shared, which is the point.
 */
export function demoSubject(): string {
  return `${DEMO_SUB_PREFIX}${randomBytes(12).toString("hex")}`;
}

/** Who a minted session names, per mode. */
const MINTED: Record<MintingMode, { subject: () => string; displayName: string }> = {
  demo: { subject: demoSubject, displayName: DEMO_DISPLAY_NAME },
  local: { subject: () => LOCAL_SUBJECT, displayName: LOCAL_DISPLAY_NAME },
};

/** Mint a session for `mode` holding `groups`. */
export function mintSession(
  mode: MintingMode,
  groups: readonly string[],
): Promise<string> {
  const who = MINTED[mode];
  return signSessionToken(who.subject(), [...groups], { displayName: who.displayName });
}

/** Mint a demo visitor's session token holding `groups`. */
export function mintDemoSession(groups: readonly string[]): Promise<string> {
  return mintSession("demo", groups);
}

/**
 * What `GET /api/auth/login` does in a minting mode, minus the cookie jar so
 * it can be tested: where to redirect, and the session to set, if any. A
 * visitor who still holds a valid session keeps it, and with it their
 * preferences and chat history; only a missing or dead one is replaced. In
 * local mode only the owner's own session is kept: one minted by another mode
 * on the same secret (a volume that ran the demo first) is replaced.
 */
export async function mintedLogin(
  mode: MintingMode,
  next: string | null,
  currentToken: string | undefined,
  groups: readonly string[],
): Promise<{ location: string; session: string | null }> {
  const location = safeNextPath(next);
  if (currentToken) {
    const current = await verifySessionToken(currentToken);
    if (current && (mode !== "local" || current.sub === LOCAL_SUBJECT)) {
      return { location, session: null };
    }
  }
  return { location, session: await mintSession(mode, groups) };
}

/** {@link mintedLogin} for demo mode. */
export function demoLogin(
  next: string | null,
  currentToken: string | undefined,
  groups: readonly string[],
): Promise<{ location: string; session: string | null }> {
  return mintedLogin("demo", next, currentToken, groups);
}
