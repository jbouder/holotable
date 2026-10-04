import { cookies } from "next/headers";
import { exchangeCode, OidcGrantRefused } from "@/lib/auth/oidc";
import { identityFromPayload, realmJwks } from "@/lib/auth/session";
import { completeSignIn, SignInRefused } from "@/lib/auth/sign-in";
import { setSessionCookie, setSessionIdCookie } from "@/lib/auth/cookie";
import { startSession } from "@/lib/auth/renewal";
import { renewalDeps } from "@/lib/auth/session-store";
import { HttpError } from "@/lib/auth/authorize";
import { config } from "@/lib/config";
import { route } from "@/lib/http";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * Keycloak OIDC callback. Verifies state, exchanges the code with its PKCE
 * verifier, validates the id_token via the realm's JWKS (RS256) and requires
 * its nonce to be this browser's (#281) — only the validated sub + groups are trusted for
 * authorization — and mints a first-party session cookie. The display name and
 * email are carried over as display-only claims (#208). When the realm issued a
 * refresh token the session is renewable (#27). A 404 in demo mode.
 */
export const GET = route("auth.callback", async (req: Request) => {
  // Demo mode has no realm to come back from (#251).
  if (config.authMode === "demo") throw new HttpError(404, "not found");
  const url = new URL(req.url);

  // Read once and deleted at once, whatever happens next: each value is good
  // for exactly one attempt.
  const store = await cookies();
  const handshake = {
    state: store.get(config.oidcStateCookieName)?.value,
    nonce: store.get(config.oidcNonceCookieName)?.value,
    verifier: store.get(config.oidcVerifierCookieName)?.value,
  };
  store.delete(config.oidcStateCookieName);
  store.delete(config.oidcNonceCookieName);
  store.delete(config.oidcVerifierCookieName);

  let signIn: Awaited<ReturnType<typeof completeSignIn>>;
  try {
    signIn = await completeSignIn(
      { code: url.searchParams.get("code"), state: url.searchParams.get("state") },
      handshake,
      {
        exchange: (code, verifier) => exchangeCode(url.origin, code, verifier),
        keys: realmJwks(),
        issuer: process.env.OIDC_ISSUER,
        audience: process.env.OIDC_AUDIENCE || undefined,
      },
    );
  } catch (err) {
    if (err instanceof SignInRefused) {
      throw err.reason === "id_token"
        ? new HttpError(401, "id_token verification failed")
        : new HttpError(400, `invalid sign-in ${err.reason}`);
    }
    // The realm refused the code: expired, already used, or not redeemable
    // with this browser's PKCE verifier, which is where a code taken from
    // someone else's sign-in ends (#281). The browser's to retry, not ours.
    if (err instanceof OidcGrantRefused) {
      throw new HttpError(400, "invalid sign-in code");
    }
    throw err;
  }
  const { tokens } = signIn;
  const identity = identityFromPayload(signIn.claims);
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
