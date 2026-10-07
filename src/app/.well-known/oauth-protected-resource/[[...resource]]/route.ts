import { HttpError } from "@/lib/auth/authorize";
import {
  MCP_PATH,
  mcpAuthDeps,
  mcpEnabled,
  mcpOrigin,
  protectedResourceMetadata,
} from "@/lib/auth/mcp-token";
import { json, route } from "@/lib/http";

export const runtime = "nodejs";

/**
 * OAuth protected-resource metadata (RFC 9728) for the MCP endpoint (#149).
 * Unauthenticated by nature: it is how a client that was just refused finds
 * the realm. Served at the path the 401 challenge names
 * (`/.well-known/oauth-protected-resource/api/mcp`) and at the bare prefix,
 * which is where a client that ignores the challenge looks; the same
 * document either way, and a 404 for any other suffix, or until the MCP
 * client is configured.
 */
export const GET = route(
  "mcp.metadata",
  async (
    req: Request,
    ctx: RouteContext<"/.well-known/oauth-protected-resource/[[...resource]]">,
  ) => {
    const deps = mcpAuthDeps();
    const { resource } = await ctx.params;
    const suffix = resource ? `/${resource.join("/")}` : "";
    if (!mcpEnabled(deps) || !deps.issuer || (suffix !== "" && suffix !== MCP_PATH)) {
      throw new HttpError(404, "not found");
    }
    return json(protectedResourceMetadata(mcpOrigin(req), deps.issuer), {
      headers: { "Cache-Control": "no-store" },
    });
  },
  { quiet: true },
);
