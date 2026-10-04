import { cookies } from "next/headers";
import { buildAuthorizeUrl } from "@/lib/auth/oidc";
import { newHandshake } from "@/lib/auth/sign-in";
import { demoLogin } from "@/lib/auth/demo";
import { setSessionCookie } from "@/lib/auth/cookie";
import { verifySessionToken } from "@/lib/auth/session";
import { config } from "@/lib/config";
import { route } from "@/lib/http";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * Begin a session. With `AUTH_MODE=oidc` (the default) this starts the
 * Keycloak OIDC flow. With `AUTH_MODE=demo` it mints a demo visitor's session
 * on the spot and sends the browser to `?next=` (#251).
 */
export const GET = route("auth.login", async (req: Request) => {
  if (config.authMode === "demo") return demoSession(req);

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

  const url = await buildAuthorizeUrl(origin, handshake);
  return Response.redirect(url, 302);
});

async function demoSession(req: Request): Promise<Response> {
  const store = await cookies();
  const { location, session } = await demoLogin(
    new URL(req.url).searchParams.get("next"),
    store.get(config.sessionCookieName)?.value,
    config.demoGroups,
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
        detail: { mode: "demo" },
      });
    }
  }
  // Relative, for the same reason as the OIDC callback: behind a container
  // the server's own origin is its bind address, not the host the browser
  // used, and an absolute redirect would drop the cookie just set.
  return new Response(null, { status: 302, headers: { Location: location } });
}
