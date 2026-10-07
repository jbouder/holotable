import { accountSummary } from "@/lib/account";
import { HttpError } from "@/lib/auth/authorize";
import {
  authenticateMcp,
  mcpAuthDeps,
  mcpChallenge,
  mcpEnabled,
  mcpOrigin,
} from "@/lib/auth/mcp-token";
import { json, route } from "@/lib/http";
import { log, amendRequest } from "@/lib/log";

export const runtime = "nodejs";

/**
 * The MCP endpoint (#149, #148).
 *
 * This is the one route that accepts a realm-issued token, and it accepts
 * nothing else: no session cookie, so a browser page cannot reach it with
 * one, and a bearer header that does not verify is a refusal rather than a
 * fall back. A call with no credential, or a refused one, is answered 401
 * with the `WWW-Authenticate` challenge that sends an MCP client to the realm
 * (`src/lib/auth/mcp-token.ts`). A 404 until `OIDC_MCP_CLIENT_ID` is set,
 * and always in demo mode.
 *
 * Until the MCP tools arrive (#148) the authenticated surface is small: GET
 * answers with the caller's own identity, the way `/api/me` does, so a client
 * configuration can be checked end to end; POST, which the MCP protocol
 * speaks, is a 501 saying so.
 */
async function authenticate(req: Request) {
  const deps = mcpAuthDeps();
  if (!mcpEnabled(deps)) throw new HttpError(404, "not found");
  const result = await authenticateMcp(req.headers.get("authorization"), deps);
  if (!result.ok) {
    log.warn("mcp.unauthenticated", { reason: result.reason });
    throw mcpChallenge(mcpOrigin(req), result.reason);
  }
  amendRequest({ sub: result.identity.sub });
  return result.identity;
}

export const GET = route("mcp", async (req: Request) => {
  const identity = await authenticate(req);
  return json(accountSummary(identity), { headers: { "Cache-Control": "no-store" } });
});

export const POST = route("mcp", async (req: Request) => {
  await authenticate(req);
  throw new HttpError(501, "MCP tools are not available yet (#148)");
});
