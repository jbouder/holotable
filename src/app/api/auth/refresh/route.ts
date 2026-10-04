import { HttpError } from "@/lib/auth/authorize";
import {
  clearSessionCookie,
  readSessionIdCookie,
  setSessionCookie,
  setSessionIdCookie,
} from "@/lib/auth/cookie";
import { renewSession } from "@/lib/auth/renewal";
import { renewalDeps } from "@/lib/auth/session-store";
import { config } from "@/lib/config";
import { json, route } from "@/lib/http";

export const runtime = "nodejs";

/**
 * Renew the session (#27).
 *
 * Authenticated by the renewal cookie alone, not by the session cookie: the
 * point is to work after the session token has expired, as long as the realm
 * session behind it has not. The realm is asked for a fresh id_token, the
 * groups are re-derived from it, and a new session token is minted, so
 * whatever the realm says about this person NOW is what the new token carries.
 *
 * - 200 `{ expiresAt }` — renewed; the client schedules the next renewal.
 * - 401 — there is nothing to renew (no session, or the realm ended it); both
 *   cookies are cleared and the person has to sign in again.
 * - 503 — the realm or the database did not answer; nothing is cleared, and
 *   the same request may succeed in a moment.
 *
 * POST, so a cross-site page cannot trigger it with the cookies attached
 * (`SameSite=Lax`); and if one could, it would only renew the victim's own
 * session. A 404 in demo mode, where there is no realm to ask.
 */
export const POST = route("auth.refresh", async () => {
  if (config.authMode === "demo") throw new HttpError(404, "not found");

  const sessionId = await readSessionIdCookie();
  if (!sessionId) throw new HttpError(401, "no renewable session");

  const outcome = await renewSession(renewalDeps, sessionId);
  if (!outcome.ok) {
    if (outcome.reason === "unavailable") {
      throw new HttpError(503, "session renewal is unavailable; try again shortly", {
        "Retry-After": "10",
      });
    }
    await clearSessionCookie();
    throw new HttpError(401, "session ended; sign in again");
  }

  await setSessionCookie(outcome.sessionToken, outcome.tokenTtl);
  await setSessionIdCookie(outcome.renewal.sessionId, outcome.renewal.ttl);
  return json(
    { expiresAt: outcome.expiresAt },
    { headers: { "Cache-Control": "no-store" } },
  );
});
