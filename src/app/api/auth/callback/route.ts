import { cookies } from "next/headers";
import { exchangeCode } from "@/lib/auth/oidc";
import { verifySessionToken, signSessionToken } from "@/lib/auth/session";
import { setSessionCookie } from "@/lib/auth/cookie";
import { errorResponse, HttpError } from "@/lib/auth/authorize";

export const runtime = "nodejs";

/**
 * Keycloak OIDC callback. Verifies state, exchanges the code, validates the
 * id_token via JWKS (RS256) — only the validated sub + groups are trusted — and
 * mints a first-party session cookie.
 */
export async function GET(req: Request) {
  try {
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

    const session = await signSessionToken(identity.sub, groups);
    await setSessionCookie(session);

    return Response.redirect(new URL("/dashboards", url.origin), 302);
  } catch (err) {
    return errorResponse(err);
  }
}
