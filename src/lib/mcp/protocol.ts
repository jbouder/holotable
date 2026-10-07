import { z } from "zod";
import { HttpError } from "@/lib/auth/authorize";
import type { Identity } from "@/lib/auth/claims";
import { readJson } from "@/lib/http";
import { log } from "@/lib/log";
import { callTool, type McpTool, toolDescriptor } from "@/lib/mcp/tool";
import { appVersion } from "@/lib/version";

/**
 * The MCP wire protocol at `/api/mcp` (#148): JSON-RPC 2.0 over the
 * Streamable HTTP transport, in its stateless form.
 *
 * Stateless on purpose. Every call arrives authenticated on its own bearer
 * token (`src/lib/auth/mcp-token.ts`), so there is nothing a session would
 * add and nothing for a second instance to share: no `Mcp-Session-Id`, no
 * server-initiated stream (a GET is answered 405), and every POST is
 * answered with one JSON body rather than an event stream, which the
 * transport allows. That is also why this is a few hundred lines rather than
 * a dependency: the server half of the protocol that applies here is
 * `initialize`, `ping`, `tools/list` and `tools/call`. The official SDK's
 * client drives it in `test/mcp-client.test.ts`.
 *
 * The protocol version is negotiated in `initialize` and, from then on,
 * stated by the client in `MCP-Protocol-Version`; an unsupported one is a
 * 400, as the transport requires. JSON-RPC batches were dropped from the
 * protocol in 2025-06-18 and are refused here.
 */

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;
export const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];

export const SERVER_INFO = {
  name: "holotable",
  title: "Holotable",
  version: appVersion,
} as const;

/** One tool call's arguments, or a spec to save, is well under this. */
const MAX_BODY_BYTES = 1024 * 1024;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const RequestId = z.union([z.string(), z.number()]);
const Params = z.record(z.string(), z.unknown());

/** A request or a notification; a response from the client is ignored. */
const Message = z.object({
  jsonrpc: z.literal("2.0"),
  id: RequestId.optional(),
  method: z.string().optional(),
  params: Params.optional(),
});

const InitializeParams = z.object({
  protocolVersion: z.string(),
  clientInfo: z.object({ name: z.string(), version: z.string().optional() }).optional(),
});

const CallParams = z.object({
  name: z.string(),
  arguments: Params.optional(),
});

export interface McpServer {
  identity: Identity;
  tools: readonly McpTool[];
  /** Shown to the model when the client asks; how the tools fit together. */
  instructions?: string;
}

type RequestId = z.infer<typeof RequestId>;

const NO_STORE = { "Cache-Control": "no-store" } as const;

function reply(id: RequestId | null, result: unknown, status = 200): Response {
  return Response.json({ jsonrpc: "2.0", id, result }, { status, headers: NO_STORE });
}

function refuse(
  id: RequestId | null,
  code: number,
  message: string,
  status = 200,
): Response {
  return Response.json(
    { jsonrpc: "2.0", id, error: { code, message } },
    { status, headers: NO_STORE },
  );
}

/** A notification, or a response to a request this server never made: taken, not answered. */
function accepted(): Response {
  return new Response(null, { status: 202, headers: NO_STORE });
}

/** The answer to anything but a POST: there is no stream to open and no session to end. */
export function methodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST", ...NO_STORE } });
}

/** Handle one POST to the MCP endpoint for an already authenticated caller. */
export async function handleMcpPost(req: Request, server: McpServer): Promise<Response> {
  let body: unknown;
  try {
    body = await readJson(req, z.unknown(), { maxBytes: MAX_BODY_BYTES });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 400;
    return refuse(null, PARSE_ERROR, "the body is not a JSON-RPC message", status);
  }
  if (Array.isArray(body)) {
    return refuse(null, INVALID_REQUEST, "JSON-RPC batches are not supported", 400);
  }
  const message = Message.safeParse(body);
  if (!message.success) {
    return refuse(null, INVALID_REQUEST, "the body is not a JSON-RPC message", 400);
  }
  const { id, method, params } = message.data;
  if (method === undefined || id === undefined) return accepted();

  // Stated by the client after `initialize`; nothing else is negotiated.
  const stated = req.headers.get("mcp-protocol-version");
  if (
    method !== "initialize" &&
    stated !== null &&
    !(PROTOCOL_VERSIONS as readonly string[]).includes(stated)
  ) {
    return refuse(
      id,
      INVALID_REQUEST,
      `unsupported MCP-Protocol-Version ${JSON.stringify(stated)}; this server speaks ${PROTOCOL_VERSIONS.join(", ")}`,
      400,
    );
  }

  switch (method) {
    case "initialize": {
      const init = InitializeParams.safeParse(params ?? {});
      if (!init.success)
        return refuse(id, INVALID_PARAMS, "initialize needs protocolVersion");
      const requested = init.data.protocolVersion;
      // A version this server speaks is answered as asked; any other with the
      // newest one, and the client decides whether it can talk to that.
      const protocolVersion = (PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;
      log.info("mcp.initialize", {
        client: init.data.clientInfo?.name,
        requested,
        protocolVersion,
      });
      return reply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        ...(server.instructions ? { instructions: server.instructions } : {}),
      });
    }
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: server.tools.map(toolDescriptor) });
    case "tools/call": {
      const call = CallParams.safeParse(params ?? {});
      if (!call.success)
        return refuse(id, INVALID_PARAMS, "tools/call needs a tool name");
      const tool = server.tools.find((t) => t.name === call.data.name);
      if (!tool) return refuse(id, INVALID_PARAMS, `unknown tool: ${call.data.name}`);
      const result = await callTool(tool, call.data.arguments, {
        identity: server.identity,
      });
      log.info("mcp.tool", { tool: tool.name, isError: result.isError === true });
      return reply(id, result);
    }
    default:
      return refuse(id, METHOD_NOT_FOUND, `method not found: ${method}`);
  }
}
