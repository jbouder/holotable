import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { parseGroups } from "@/lib/auth/claims";
import { handleMcpPost, type McpServer, methodNotAllowed } from "@/lib/mcp/protocol";
import { defineTool, READ_ONLY } from "@/lib/mcp/tool";
import type { McpDeps } from "@/lib/mcp/tools/deps";
import { sourceTools } from "@/lib/mcp/tools/sources";
import { sqlTools } from "@/lib/mcp/tools/sql";
import type { SourceRecord } from "@/lib/registry";
import { PrometheusConfig } from "@/lib/sources/kinds/prometheus";

/**
 * The official MCP client against this server's protocol layer (#148): the
 * one check that the hand-written transport is the transport the clients
 * speak. A small Node server adapts the Request/Response handler, the way
 * the Next route does, with a fixed identity standing in for the bearer
 * token the route verifies.
 */

const identity = parseGroups("alice", ["/workspaces/ops/editor"]);

const server: McpServer = {
  identity,
  instructions: "Testing.",
  tools: [
    defineTool({
      name: "whoami",
      title: "Who am I",
      description: "The caller.",
      input: z.object({ shout: z.boolean().optional() }),
      output: z.object({ sub: z.string() }),
      annotations: READ_ONLY,
      async run(args, { identity }) {
        return { sub: args.shout ? identity.sub.toUpperCase() : identity.sub };
      },
    }),
  ],
};

/** A Prometheus source, for the PromQL tools through the SDK client (#389). */
const prom = {
  id: "prom",
  workspaceId: "ops",
  name: "Prom",
  kind: "prometheus",
  config: PrometheusConfig.parse({
    kind: "prometheus",
    url: "https://prometheus.internal",
    auth: "none",
    metrics: [{ name: "http_requests_total", type: "counter", labels: ["job"] }],
  }),
  secretRef: null,
  catalogRefreshedAt: new Date().toISOString(),
  catalogMissingTables: [],
  createdBy: "u",
  createdAt: "",
  updatedAt: "",
  tombstonedAt: null,
} as unknown as SourceRecord;

const promDeps = {
  getSource: async (id: string) => (id === prom.id ? prom : null),
  listSources: async () => [prom],
  executePlan: async () => ({
    columns: ["time", '{job="api"}'],
    rows: [{ time: "2026-01-01T00:00:00Z", '{job="api"}': 2 }],
  }),
} as unknown as McpDeps;

const promServer: McpServer = {
  identity,
  instructions: "PromQL.",
  tools: [...sourceTools(promDeps), ...sqlTools(promDeps)],
};

let http: Server;
let url: URL;

before(async () => {
  http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const request = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([k, v]) =>
        typeof v === "string" ? [[k, v] as [string, string]] : [],
      ),
      body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
    });
    const target = req.url?.startsWith("/api/mcp-promql") ? promServer : server;
    const response =
      req.method === "POST" ? await handleMcpPost(request, target) : methodNotAllowed();
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  url = new URL(`http://127.0.0.1:${address.port}/api/mcp`);
});

after(() => new Promise<void>((resolve) => http.close(() => resolve())));

test("the SDK client initializes, lists the tools and calls one", async () => {
  const client = new Client({ name: "holotable-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(url);
  await client.connect(transport);
  try {
    assert.equal(client.getServerVersion()?.name, "holotable");
    assert.equal(client.getInstructions(), "Testing.");
    assert.deepEqual(client.getServerCapabilities(), { tools: { listChanged: false } });

    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ["whoami"],
    );
    assert.equal(tools[0].inputSchema.type, "object");

    const result = await client.callTool({ name: "whoami", arguments: { shout: true } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, { sub: "ALICE" });
    assert.deepEqual(result.content, [{ type: "text", text: '{"sub":"ALICE"}' }]);

    const bad = await client.callTool({ name: "whoami", arguments: { shout: "yes" } });
    assert.equal(bad.isError, true);

    assert.deepEqual(await client.ping(), {});
  } finally {
    await client.close();
  }
});

test("the SDK client describes a Prometheus source, validates and runs PromQL (#389)", async () => {
  const client = new Client({ name: "holotable-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/api/mcp-promql", url)),
  );
  try {
    const { tools } = await client.listTools();
    const validate = tools.find((t) => t.name === "validate_sql");
    assert.ok(validate);
    const properties = validate.inputSchema.properties as Record<string, unknown>;
    assert.ok("sql" in properties && "promql" in properties && "instant" in properties);

    const described = await client.callTool({
      name: "describe_source",
      arguments: { sourceId: "prom" },
    });
    assert.equal(described.isError, undefined);
    assert.equal((described.structuredContent as { kind: string }).kind, "prometheus");
    assert.doesNotMatch(JSON.stringify(described.content), /prometheus\.internal/);

    const checked = await client.callTool({
      name: "validate_sql",
      arguments: { sourceId: "prom", promql: "sum(rate(http_requests_total[5m]))" },
    });
    assert.deepEqual(checked.structuredContent, { ok: true });

    const ran = await client.callTool({
      name: "run_query",
      arguments: {
        sourceId: "prom",
        promql: "sum by (job) (rate(http_requests_total[5m]))",
        timeRange: { from: "now-1h", to: "now" },
      },
    });
    assert.equal(ran.isError, undefined, JSON.stringify(ran.content));
    assert.deepEqual((ran.structuredContent as { columns: string[] }).columns, [
      "time",
      '{job="api"}',
    ]);
  } finally {
    await client.close();
  }
});
