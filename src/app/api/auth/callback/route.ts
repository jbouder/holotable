import { cookies } from "next/headers";
import { exchangeCode } from "@/lib/auth/oidc";
import { verifySessionToken } from "@/lib/auth/session";
import { setSessionCookie, setSessionIdCookie } from "@/lib/auth/cookie";
import { startSession } from "@/lib/auth/renewal";
import { renewalDeps } from "@/lib/auth/session-store";
import { HttpError } from "@/lib/auth/authorize";
import { config } from "@/lib/config";
import { route } from "@/lib/http";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * Keycloak OIDC callback. Verifies state, exchanges the code, validates the
 * id_token via JWKS (RS256) — only the validated sub + groups are trusted for
 * authorization — and mints a first-party session cookie. The display name and
 * email are carried over as display-only claims (#208). When the realm issued a
 * refresh token the session is renewable (#27). A 404 in demo mode.
 */
export const GET = route("auth.callback", async (req: Request) => {
  // Demo mode has no realm to come back from (#251).
  if (config.authMode === "demo") throw new HttpError(404, "not found");
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw new HttpError(400, "missing code/state");

  const store = await cookies();
  const expected = store.get("holotable_oidc_state")?.value;
  if (!expected || expected !== state) throw new HttpError(400, "invalid state");
  store.delete("holotable_oidc_state");

  const tokens = await exchangeCode(url.origin, code);
  const identity = await verifySessionToken(tokens.id_token);
  if (!identity) throw new HttpError(401, "id_token verification failed");

  // With a refresh token the session is short-lived and renewable (#27); the
  // refresh token itself stays on the server and the browser gets only an
  // opaque id for it.
  const issued = await startSession(renewalDeps, identity, tokens);
  await setSessionCookie(issued.sessionToken, issued.tokenTtl);
  if (issued.renewal) {
    await setSessionIdCookie(issued.renewal.sessionId, issued.renewal.ttl);
  }
  // A sign-in belongs to no one workspace, so its row has none (#30).
  audit({
    actor: identity,
    action: "auth.login",
    workspaceId: null,
    detail: { mode: "oidc", renewable: issued.renewal !== undefined },
  });

  // Redirect relative to the browser's current origin. Deriving an absolute
  // URL from url.origin is unsafe here: behind the container the server
  // reports its bind host (0.0.0.0), so an absolute redirect would move the
  // browser off the host the session cookie was just set on (localhost),
  // dropping the cookie and bouncing back to login.
  //
  // `/` rather than `/dashboards`: the home route sends the new session to the
  // person's chosen start page (#215), with the same fallbacks either way.
  return new Response(null, { status: 302, headers: { Location: "/" } });
});
