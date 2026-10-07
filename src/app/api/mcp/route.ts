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
import { amendRequest, log } from "@/lib/log";
import { handleMcpPost, methodNotAllowed } from "@/lib/mcp/protocol";
import { MCP_INSTRUCTIONS, mcpTools } from "@/lib/mcp/tools";
import type { McpTool } from "@/lib/mcp/tool";

export const runtime = "nodejs";

/** The generation tools call the model, under the same deadline as `/api/generate`. */
export const maxDuration = 60;

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
 * POST is the protocol (`src/lib/mcp/protocol.ts`), stateless, over the
 * tools in `src/lib/mcp/tools/`, each of which authorizes the identity
 * resolved here with `can()` exactly as the matching HTTP route does. GET
 * answers with the caller's own identity, the way `/api/me` does, so a client
 * configuration can be checked with curl; an MCP client asking for a
 * server-initiated event stream on GET gets the 405 the transport allows.
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

let tools: McpTool[] | undefined;

export const GET = route("mcp", async (req: Request) => {
  const identity = await authenticate(req);
  if (req.headers.get("accept")?.includes("text/event-stream")) return methodNotAllowed();
  return json(accountSummary(identity), { headers: { "Cache-Control": "no-store" } });
});

export const POST = route("mcp", async (req: Request) => {
  const identity = await authenticate(req);
  tools ??= mcpTools();
  return handleMcpPost(req, { identity, tools, instructions: MCP_INSTRUCTIONS });
});
