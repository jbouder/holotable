import { cookies } from "next/headers";
import { exchangeCode } from "@/lib/auth/oidc";
import { verifySessionToken, signSessionToken } from "@/lib/auth/session";
import { setSessionCookie } from "@/lib/auth/cookie";
import { HttpError } from "@/lib/auth/authorize";
import { route } from "@/lib/http";

export const runtime = "nodejs";

/**
 * Keycloak OIDC callback. Verifies state, exchanges the code, validates the
 * id_token via JWKS (RS256) — only the validated sub + groups are trusted for
 * authorization — and mints a first-party session cookie. The display name and
 * email are carried over as display-only claims (#208).
 */
export const GET = route("auth.callback", async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw new HttpError(400, "missing code/state");

  const store = await cookies();
  const expected = store.get("holotable_oidc_state")?.value;
  if (!expected || expected !== state) throw new HttpError(400, "invalid state");
  store.delete("holotable_oidc_state");

  const { id_token } = await exchangeCode(url.origin, code);
  const identity = await verifySessionToken(id_token);
  if (!identity) throw new HttpError(401, "id_token verification failed");

  const groups = Object.entries(identity.workspaces).map(
    ([ws, role]) => `/workspaces/${ws}/${role}`,
  );
  if (identity.platformAdmin) groups.push("/platform-admins");

  const session = await signSessionToken(identity.sub, groups, {
    displayName: identity.displayName,
    email: identity.email,
  });
  await setSessionCookie(session);

  // Redirect relative to the browser's current origin. Deriving an absolute
  // URL from url.origin is unsafe here: behind the container the server
  // reports its bind host (0.0.0.0), so an absolute redirect would move the
  // browser off the host the session cookie was just set on (localhost),
  // dropping the cookie and bouncing back to login.
  return new Response(null, { status: 302, headers: { Location: "/dashboards" } });
});
