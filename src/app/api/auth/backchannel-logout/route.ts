import { HttpError } from "@/lib/auth/authorize";
import { verifyLogoutToken } from "@/lib/auth/backchannel";
import { revoke } from "@/lib/auth/revocation";
import { realmJwks } from "@/lib/auth/session";
import { removeSessionsFor } from "@/lib/auth/session-store";
import { config } from "@/lib/config";
import { route } from "@/lib/http";
import { audit } from "@/lib/audit";
import { log } from "@/lib/log";

export const runtime = "nodejs";

/** A logout token is a few hundred bytes; anything near this is not one. */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * OIDC back-channel logout (#28). Keycloak calls this, server to server, when
 * a realm session ends, with a signed `logout_token` naming the session
 * (`sid`), the person (`sub`), or both.
 *
 * Takes effect at once, in this order:
 * 1. the session is revoked in memory, so its session token stops verifying
 *    on the next request instead of at its expiry;
 * 2. open dashboard streams carrying it are told and closed (the revocation
 *    listeners);
 * 3. its `sessions` rows are deleted, so it cannot be renewed.
 *
 * Unauthenticated by nature: the logout token's signature, issuer, audience,
 * age and `events` claim are the whole check (`verifyLogoutToken`). Answers
 * 400 to anything that fails it, and 200 once the revocation is in force,
 * even if the row delete then fails — a row left behind can only be renewed
 * by asking the realm, which has ended that session. A 404 when there is no
 * realm (demo mode, or OIDC not configured).
 */
export const POST = route("auth.backchannel_logout", async (req: Request) => {
  const keys = realmJwks();
  const issuer = process.env.OIDC_ISSUER;
  const clientId = process.env.OIDC_CLIENT_ID;
  if (config.authMode === "demo" || !keys || !issuer || !clientId) {
    throw new HttpError(404, "not found");
  }
  // A logout token is addressed to one client; the realm sends one for the
  // MCP client's sessions too (#149), and those end the same way.
  const audience = config.oidcMcpClientId ? [clientId, config.oidcMcpClientId] : clientId;

  const body = await req.text();
  if (body.length > MAX_BODY_BYTES) return refuse();
  const token = new URLSearchParams(body).get("logout_token");
  if (!token) return refuse();

  const claims = await verifyLogoutToken(token, keys, { issuer, audience });
  if (!claims) {
    log.warn("auth.backchannel_logout.rejected");
    return refuse();
  }

  revoke(claims);
  let rows = 0;
  try {
    rows = await removeSessionsFor(claims);
  } catch (err) {
    log.warn("auth.backchannel_logout.store_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  log.info("auth.backchannel_logout", {
    sub: claims.sub,
    bySession: claims.sid !== undefined,
    rows,
  });
  // The realm is the actor; the subject is the person whose sessions ended,
  // when the token names one, as it is validated by the realm's signature.
  audit({
    actor: { kind: "realm", sub: claims.sub ?? "realm" },
    action: "auth.backchannel_logout",
    workspaceId: null,
    detail: { bySession: claims.sid !== undefined, sessions: rows },
  });
  return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
});

/** §2.8: a token that fails validation is a 400 with an OAuth-style error. */
function refuse(): Response {
  return Response.json(
    { error: "invalid_request", error_description: "invalid logout token" },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}
