import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { HttpError } from "@/lib/auth/authorize";
import { parseGroups } from "@/lib/auth/claims";
import {
  handleMcpPost,
  LATEST_PROTOCOL_VERSION,
  type McpServer,
  methodNotAllowed,
  PROTOCOL_VERSIONS,
  SERVER_INFO,
} from "@/lib/mcp/protocol";
import {
  type CallToolResult,
  callTool,
  defineTool,
  READ_ONLY,
  toolDescriptor,
} from "@/lib/mcp/tool";

/** The MCP wire protocol at /api/mcp (#148): stateless JSON-RPC over one POST each. */

const identity = parseGroups("alice", ["/workspaces/ops/editor"]);

const echo = defineTool({
  name: "echo",
  title: "Echo",
  description: "Says it back.",
  input: z.object({ text: z.string().min(1).describe("What to say") }),
  output: z.object({ said: z.string(), by: z.string() }),
  annotations: READ_ONLY,
  async run(args, { identity }) {
    return { said: args.text, by: identity.sub };
  },
});

const refused = defineTool({
  name: "refused",
  title: "Refused",
  description: "Always a 403.",
  input: z.object({}),
  annotations: READ_ONLY,
  async run() {
    throw new HttpError(403, "not authorized for dashboard:update");
  },
});

const broken = defineTool({
  name: "broken",
  title: "Broken",
  description: "Throws something unexpected.",
  input: z.object({}),
  annotations: READ_ONLY,
  async run() {
    throw new TypeError("secret internal detail");
  },
});

const server: McpServer = {
  identity,
  tools: [echo, refused, broken],
  instructions: "Say things.",
};

/** What comes back on the wire, read with the same strictness a client would. */
const Body = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

interface Descriptor {
  name: string;
  inputSchema: {
    type: string;
    required?: string[];
    properties: Record<string, { type?: string; description?: string }>;
  };
  outputSchema?: { required?: string[] };
  annotations: unknown;
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function rpc(method: string, params?: unknown, headers?: Record<string, string>) {
  const res = await handleMcpPost(
    post({ jsonrpc: "2.0", id: 1, method, params }, headers),
    server,
  );
  return { status: res.status, body: Body.parse(await res.json()) };
}

const asCall = (result: Record<string, unknown> | undefined) =>
  result as unknown as CallToolResult;

test("initialize negotiates the version, names the server and hands over the instructions", async () => {
  const { status, body } = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    clientInfo: { name: "test" },
  });
  assert.equal(status, 200);
  assert.equal(body.id, 1);
  assert.deepEqual(body.result, {
    protocolVersion: "2025-03-26",
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions: "Say things.",
  });
  // A version this server does not speak gets the newest it does.
  const newer = await rpc("initialize", { protocolVersion: "2099-01-01" });
  assert.equal(newer.body.result?.protocolVersion, LATEST_PROTOCOL_VERSION);
  assert.equal(PROTOCOL_VERSIONS[0], LATEST_PROTOCOL_VERSION);
});

test("tools/list advertises each tool's JSON Schema, from the same zod schema that validates it", async () => {
  const { body } = await rpc("tools/list");
  const tools = body.result?.tools as Descriptor[];
  assert.deepEqual(
    tools.map((t) => t.name),
    ["echo", "refused", "broken"],
  );
  const [tool] = tools;
  assert.deepEqual(tool, toolDescriptor(echo));
  assert.equal(tool.inputSchema.type, "object");
  assert.deepEqual(tool.inputSchema.required, ["text"]);
  assert.equal(tool.inputSchema.properties.text.description, "What to say");
  assert.equal("$schema" in tool.inputSchema, false);
  assert.deepEqual(tool.outputSchema?.required, ["said", "by"]);
  assert.deepEqual(tool.annotations, READ_ONLY);
});

test("tools/call runs the tool for the caller and returns text and structured content", async () => {
  const { body } = await rpc("tools/call", { name: "echo", arguments: { text: "hi" } });
  assert.deepEqual(body.result, {
    content: [{ type: "text", text: '{"said":"hi","by":"alice"}' }],
    structuredContent: { said: "hi", by: "alice" },
  });
});

test("a tool's failure is a result with isError, never a protocol error", async () => {
  const invalid = await rpc("tools/call", { name: "echo", arguments: { text: "" } });
  assert.equal(invalid.status, 200);
  const invalidResult = asCall(invalid.body.result);
  assert.equal(invalidResult.isError, true);
  assert.match(invalidResult.content[0].text, /^invalid arguments: text: /);

  const denied = await rpc("tools/call", { name: "refused" });
  assert.deepEqual(denied.body.result, {
    content: [{ type: "text", text: "not authorized for dashboard:update" }],
    isError: true,
  });

  // The cause stays in the log; the model gets the request to quote.
  const crashed = asCall((await rpc("tools/call", { name: "broken" })).body.result);
  assert.equal(crashed.isError, true);
  assert.doesNotMatch(crashed.content[0].text, /secret internal detail/);
  assert.match(crashed.content[0].text, /^the tool failed; the server log/);
});

test("an unknown tool or method is a JSON-RPC error", async () => {
  const tool = await rpc("tools/call", { name: "nope" });
  assert.equal(tool.status, 200);
  assert.deepEqual(tool.body.error, { code: -32602, message: "unknown tool: nope" });
  const method = await rpc("resources/list");
  assert.deepEqual(method.body.error, {
    code: -32601,
    message: "method not found: resources/list",
  });
  const ping = await rpc("ping");
  assert.deepEqual(ping.body.result, {});
});

test("a notification is accepted with no body, and so is a stray response", async () => {
  for (const body of [
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 7, result: {} },
  ]) {
    const res = await handleMcpPost(post(body), server);
    assert.equal(res.status, 202);
    assert.equal(await res.text(), "");
  }
});

test("what is not a JSON-RPC message, or a batch, or an unsupported version, is a 400", async () => {
  const cases: [string, unknown][] = [
    ["not json", "{"],
    ["not a message", { hello: "world" }],
    ["wrong version", { jsonrpc: "1.0", id: 1, method: "ping" }],
    ["a batch", [{ jsonrpc: "2.0", id: 1, method: "ping" }]],
  ];
  for (const [name, body] of cases) {
    const res = await handleMcpPost(post(body), server);
    assert.equal(res.status, 400, name);
    const json = Body.parse(await res.json());
    assert.equal(json.id, null, name);
    assert.ok(json.error?.code === -32700 || json.error?.code === -32600, name);
  }
  const stated = await rpc("ping", undefined, { "mcp-protocol-version": "1999-01-01" });
  assert.equal(stated.status, 400);
  assert.match(
    stated.body.error?.message ?? "",
    /unsupported MCP-Protocol-Version "1999-01-01"/,
  );
  // Stated and supported, or not stated at all, is fine; initialize never checks it.
  assert.equal(
    (await rpc("ping", undefined, { "mcp-protocol-version": "2025-06-18" })).status,
    200,
  );
  assert.equal(
    (
      await rpc(
        "initialize",
        { protocolVersion: "2025-06-18" },
        { "mcp-protocol-version": "1999-01-01" },
      )
    ).status,
    200,
  );
});

test("there is no stream to open and no session to end", () => {
  const res = methodNotAllowed();
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
});

test("a tool with a wider parse than its documented input validates with the wider one", async () => {
  const tool = defineTool({
    name: "wide",
    title: "Wide",
    description: "",
    input: z.object({ n: z.number() }),
    parse: z.object({ n: z.coerce.number() }),
    annotations: READ_ONLY,
    async run(args) {
      return { n: args.n };
    },
  });
  assert.deepEqual((await callTool(tool, { n: "4" }, { identity })).structuredContent, {
    n: 4,
  });
  // The client is shown the documented input, not the wider one.
  assert.deepEqual(toolDescriptor(tool).inputSchema, {
    type: "object",
    properties: { n: { type: "number" } },
    required: ["n"],
  });
});
