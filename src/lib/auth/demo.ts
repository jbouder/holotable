import { randomBytes } from "node:crypto";
import { safeNextPath } from "@/lib/auth/next-path";
import { signSessionToken, verifySessionToken } from "@/lib/auth/session";

/**
 * Demo-mode session minting (#251), the one exception to "Keycloak is the only
 * way in" and only reachable when `AUTH_MODE=demo`.
 *
 * The exception lives in *minting*, never in *verification*. A demo session is
 * an ordinary first-party HS256 token: `verifySessionToken`, the claims parser
 * and `can()` treat it exactly like one minted by the OIDC callback, so there
 * is no second code path deciding who may do what. What keeps it safe is
 * `validateConfig`, which refuses to boot demo mode beside a real realm or
 * with groups above editor.
 */

/** Prefix on every demo subject, so a log line or a row is recognisably one. */
export const DEMO_SUB_PREFIX = "demo:";
export const DEMO_DISPLAY_NAME = "Demo visitor";

/**
 * A fresh subject per visitor. Preferences, favorites, chat history and the
 * per-user model rate bucket are keyed by `sub`, so each visitor gets their
 * own; dashboards are workspace-scoped and shared, which is the point.
 */
export function demoSubject(): string {
  return `${DEMO_SUB_PREFIX}${randomBytes(12).toString("hex")}`;
}

/** Mint a demo visitor's session token holding `groups`. */
export function mintDemoSession(groups: readonly string[]): Promise<string> {
  return signSessionToken(demoSubject(), [...groups], {
    displayName: DEMO_DISPLAY_NAME,
  });
}

/**
 * What `GET /api/auth/login` does in demo mode, minus the cookie jar so it can
 * be tested: where to redirect, and the session to set, if any. A visitor who
 * still holds a valid session keeps it, and with it their preferences and chat
 * history; only a missing or dead one is replaced.
 */
export async function demoLogin(
  next: string | null,
  currentToken: string | undefined,
  groups: readonly string[],
): Promise<{ location: string; session: string | null }> {
  const location = safeNextPath(next);
  if (currentToken && (await verifySessionToken(currentToken))) {
    return { location, session: null };
  }
  return { location, session: await mintDemoSession(groups) };
}
