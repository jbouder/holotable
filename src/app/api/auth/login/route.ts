import { cookies } from "next/headers";
import { buildAuthorizeUrl } from "@/lib/auth/oidc";
import { newHandshake } from "@/lib/auth/sign-in";
import { mintedLogin } from "@/lib/auth/demo";
import {
  clearSessionCookie,
  readSessionIdCookie,
  setSessionCookie,
  setSessionIdCookie,
} from "@/lib/auth/cookie";
import { safeNextPath } from "@/lib/auth/next-path";
import { renewSession } from "@/lib/auth/renewal";
import { renewalDeps } from "@/lib/auth/session-store";
import { verifySessionToken } from "@/lib/auth/session";
import { config, type MintingMode } from "@/lib/config";
import { route } from "@/lib/http";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * Begin a session, and come back to `?next=` (a same-origin path, else `/`).
 * With `AUTH_MODE=oidc` (the default) a session that has only expired is
 * renewed first (#27), exactly as `POST /api/auth/refresh` would, so a tab
 * that slept past its token comes straight back without a trip to the realm;
 * otherwise this starts the Keycloak OIDC flow. With `AUTH_MODE=demo` it
 * mints a demo visitor's session on the spot (#251), and with
 * `AUTH_MODE=local` the local owner's (#600).
 *
 * A GET, unlike refresh, because the proxy sends page requests here. A
 * cross-site link that lands here can only renew, or start, the visitor's
 * own session, never anyone else's.
 */
export const GET = route("auth.login", async (req: Request) => {
  if (config.authMode !== "oidc") return mintedSession(req, config.authMode);

  const next = safeNextPath(new URL(req.url).searchParams.get("next"));
  if (await resumed()) return redirectTo(next);

  const origin = new URL(req.url).origin;
  // Checked by the callback (#281): the state, the nonce the id_token must
  // echo, and the PKCE verifier the code exchange must present.
  const handshake = newHandshake();

  const store = await cookies();
  const opts = {
    httpOnly: true,
    secure: config.sessionCookieSecure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 600,
  };
  // `__Host-` prefixed when Secure (#26), like the session cookie.
  store.set(config.oidcStateCookieName, handshake.state, opts);
  store.set(config.oidcNonceCookieName, handshake.nonce, opts);
  store.set(config.oidcVerifierCookieName, handshake.verifier, opts);
  store.set(config.oidcNextCookieName, next, opts);

  const url = await buildAuthorizeUrl(origin, handshake);
  return Response.redirect(url, 302);
});

/**
 * Renew from the renewal cookie, if there is one and the realm session
 * behind it is still good. A refusal clears both cookies, as refresh does; an
 * unavailable realm or database clears nothing and falls through to sign-in.
 */
async function resumed(): Promise<boolean> {
  const sessionId = await readSessionIdCookie();
  if (!sessionId) return false;
  const outcome = await renewSession(renewalDeps, sessionId);
  if (!outcome.ok) {
    if (outcome.reason !== "unavailable") await clearSessionCookie();
    return false;
  }
  await setSessionCookie(outcome.sessionToken, outcome.tokenTtl);
  await setSessionIdCookie(outcome.renewal.sessionId, outcome.renewal.ttl);
  return true;
}

/** Relative, for the reason the callback gives. */
function redirectTo(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}

async function mintedSession(req: Request, mode: MintingMode): Promise<Response> {
  const store = await cookies();
  const { location, session } = await mintedLogin(
    mode,
    new URL(req.url).searchParams.get("next"),
    store.get(config.sessionCookieName)?.value,
    mode === "local" ? config.localGroups : config.demoGroups,
  );
  if (session) {
    await setSessionCookie(session);
    // Only a session minted here is a sign-in; a visitor who still held one
    // is just being redirected.
    const identity = await verifySessionToken(session);
    if (identity) {
      audit({
        actor: identity,
        action: "auth.login",
        workspaceId: null,
        detail: { mode },
      });
    }
  }
  // Relative, for the same reason as the OIDC callback: behind a container
  // the server's own origin is its bind address, not the host the browser
  // used, and an absolute redirect would drop the cookie just set.
  return new Response(null, { status: 302, headers: { Location: location } });
}
