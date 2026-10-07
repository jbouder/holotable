import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "@/lib/auth/authorize";
import { parseGroups } from "@/lib/auth/claims";
import {
  baseSystem,
  MAX_GENERATION_SOURCES,
  SQL_RULES,
  sqlRules,
} from "@/lib/ai/generate";
import { WORKSPACE_BLOCK_KIND } from "@/lib/ai/prompt";
import { findUntrustedBlocks } from "@/lib/ai/untrusted";
import { resolveAndValidateDashboard } from "@/lib/dashboard-service";
import { AdditionalSourceIds, resolveGenerationSources } from "@/lib/generation-sources";
import { type Dashboard, SPEC_VERSION } from "@/lib/ir";
import { SourceConfig, type SourceRecord } from "@/lib/registry";
import {
  additionalSourceChoices,
  MAX_ADDITIONAL_SOURCES,
  pruneAdditionalSources,
  toggleAdditionalSource,
} from "@/lib/source-selection";
import { WorkspacePrompt } from "@/lib/workspace-prompt";
import { usableWorkspacePrompt } from "@/lib/workspace-prompt-service";

/**
 * Multi-source generation (#104): one model call over up to three sources of
 * one workspace, each catalog in its own fenced block, every source checked
 * on its own record, and a panel's SQL held to its own source's catalog.
 */

function makeSource(
  id: string,
  table: string,
  overrides: Partial<SourceRecord> = {},
): SourceRecord {
  return {
    id,
    workspaceId: "ws-1",
    name: id,
    kind: "timescaledb",
    config: SourceConfig.parse({
      host: "postgres",
      port: 5432,
      database: "holotable",
      schema: "metrics",
      ssl: false,
      tables: [
        {
          name: table,
          timeField: "ts",
          columns: [
            { name: "ts", type: "timestamp with time zone" },
            { name: "value", type: "double precision" },
          ],
        },
      ],
    }),
    secretRef: "TS_SRC",
    catalogRefreshedAt: new Date().toISOString(),
    catalogMissingTables: [],
    createdBy: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tombstonedAt: null,
    ...overrides,
  };
}

const app = makeSource("src-app", "http_requests");
const infra = makeSource("src-infra", "node_cpu");
const logs = makeSource("src-logs", "log_lines");

const lookup =
  (...sources: SourceRecord[]) =>
  async (id: string) =>
    sources.find((s) => s.id === id) ?? null;

const editor = parseGroups("u", ["/workspaces/ws-1/editor"]);

async function refused(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof HttpError);
    return err;
  }
  assert.fail("expected a refusal");
}

// --- The prompt --------------------------------------------------------------

test("one source gets the prompt it always had", () => {
  assert.equal(sqlRules(1), SQL_RULES);
  const system = baseSystem(app);
  assert.match(
    system,
    /^The only authorized data source for this request:\nsourceId: src-app$/m,
  );
  assert.match(system, /query\.sourceId MUST equal the provided sourceId/);
  assert.equal(findUntrustedBlocks(system, "CATALOG").length, 1);
});

test("several sources get one fenced catalog each, under a heading naming it", () => {
  const system = baseSystem(app, null, [infra]);
  const blocks = findUntrustedBlocks(system, "CATALOG");
  assert.equal(blocks.length, 2);
  assert.match(blocks[0].body, /http_requests/);
  assert.doesNotMatch(blocks[0].body, /node_cpu/);
  assert.match(blocks[1].body, /node_cpu/);
  assert.doesNotMatch(blocks[1].body, /http_requests/);
  assert.ok(
    system.indexOf('Catalog for sourceId "src-app"') <
      system.indexOf(`BEGIN CATALOG ${blocks[0].token}`),
  );
  assert.ok(
    system.indexOf('Catalog for sourceId "src-infra"') <
      system.indexOf(`BEGIN CATALOG ${blocks[1].token}`),
  );
  assert.match(system, /^sourceId: src-app\nsourceId: src-infra$/m);
  // The rule names the confusion it forbids, and the single-source rule is gone.
  assert.match(system, /MUST be one of the provided sourceIds/);
  assert.match(system, /never join or\s+combine tables from different sources/);
  assert.doesNotMatch(system, /MUST equal the provided sourceId/);
});

test("the prompt is bounded by the source cap, not by how many are asked for", () => {
  assert.equal(MAX_GENERATION_SOURCES, 1 + MAX_ADDITIONAL_SOURCES);
  assert.throws(() => baseSystem(app, null, [infra, logs, makeSource("x", "t")]));
  // Three sources cost about three catalogs: nothing else grows with them.
  const one = (s: SourceRecord) => baseSystem(s).length;
  const three = baseSystem(app, null, [infra, logs]).length;
  assert.ok(three < one(app) + one(infra) + one(logs), `${three}`);
  assert.equal(AdditionalSourceIds.safeParse(["a", "b"]).success, true);
  assert.equal(AdditionalSourceIds.safeParse(["a", "b", "c"]).success, false);
});

test("the workspace's examples are shown for every selected source", async () => {
  const panel = (sourceId: string, table: string) => ({
    id: "p",
    title: "t",
    viz: "table",
    query: { sourceId, sql: `SELECT value FROM ${table}` },
    layout: { x: 0, y: 0, w: 12, h: 4 },
  });
  const custom = WorkspacePrompt.parse({
    glossary: "",
    metricDefinitions: [],
    examples: [
      {
        prompt: "app one",
        specVersion: SPEC_VERSION,
        panel: panel("src-app", "http_requests"),
      },
      {
        prompt: "infra one",
        specVersion: SPEC_VERSION,
        panel: panel("src-infra", "node_cpu"),
      },
      {
        prompt: "logs one",
        specVersion: SPEC_VERSION,
        panel: panel("src-logs", "log_lines"),
      },
    ],
  });
  const usable = await usableWorkspacePrompt(custom, [app, infra]);
  assert.deepEqual(
    usable?.examples.map((e) => e.prompt),
    ["app one", "infra one"],
  );
  const [block] = findUntrustedBlocks(
    baseSystem(app, usable, [infra]),
    WORKSPACE_BLOCK_KIND,
  );
  assert.match(block.body, /Request: app one/);
  assert.match(block.body, /Request: infra one/);
  assert.doesNotMatch(block.body, /logs one/);
});

// --- Which sources a generation may use --------------------------------------

test("every source is resolved on its own record", async () => {
  const { source, additional } = await resolveGenerationSources({
    identity: editor,
    sourceId: "src-app",
    additionalSourceIds: ["src-infra", "src-app", "src-infra"],
    getSource: lookup(app, infra),
  });
  assert.equal(source.id, "src-app");
  assert.deepEqual(
    additional.map((s) => s.id),
    ["src-infra"],
  );
});

test("an additional source the caller may not generate in is refused, not dropped", async () => {
  const other = makeSource("src-other", "secrets", { workspaceId: "ws-2" });
  const err = await refused(
    resolveGenerationSources({
      identity: editor,
      sourceId: "src-app",
      additionalSourceIds: ["src-other"],
      getSource: lookup(app, other),
    }),
  );
  assert.equal(err.status, 403);
  // A viewer may not generate at all, in any of them.
  const viewer = parseGroups("u", ["/workspaces/ws-1/viewer"]);
  assert.equal(
    (
      await refused(
        resolveGenerationSources({
          identity: viewer,
          sourceId: "src-app",
          getSource: lookup(app),
        }),
      )
    ).status,
    403,
  );
});

test("sources in different workspaces cannot make one dashboard", async () => {
  const other = makeSource("src-other", "t", { workspaceId: "ws-2" });
  const both = parseGroups("u", ["/workspaces/ws-1/editor", "/workspaces/ws-2/editor"]);
  const err = await refused(
    resolveGenerationSources({
      identity: both,
      sourceId: "src-app",
      additionalSourceIds: ["src-other"],
      getSource: lookup(app, other),
    }),
  );
  assert.equal(err.status, 400);
  assert.match(err.message, /same workspace/);
});

test("a missing, removed or unchecked additional source refuses the request", async () => {
  const removed = makeSource("src-gone", "t", {
    tombstonedAt: "2026-02-01T00:00:00.000Z",
  });
  const unchecked = makeSource("src-new", "t", { catalogRefreshedAt: null });
  for (const id of ["src-missing", "src-gone", "src-new"]) {
    const err = await refused(
      resolveGenerationSources({
        identity: editor,
        sourceId: "src-app",
        additionalSourceIds: [id],
        getSource: lookup(app, removed, unchecked),
      }),
    );
    assert.equal(err.status, 400, id);
  }
});

// --- What a generated dashboard may save -------------------------------------

function dashboard(
  panels: Array<{ id: string; sourceId: string; sql: string }>,
): Dashboard {
  return {
    specVersion: SPEC_VERSION,
    title: "App and infra",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 30_000,
    panels: panels.map((p, i) => ({
      id: p.id,
      title: p.id,
      viz: "table",
      query: { sourceId: p.sourceId, sql: p.sql },
      layout: { x: 0, y: i * 4, w: 12, h: 4 },
    })),
  } as Dashboard;
}

test("a dashboard over two sources saves when each panel reads its own", async () => {
  const { workspaceId, sources } = await resolveAndValidateDashboard(
    dashboard([
      { id: "requests", sourceId: "src-app", sql: "SELECT value FROM http_requests" },
      { id: "cpu", sourceId: "src-infra", sql: "SELECT value FROM node_cpu" },
    ]),
    lookup(app, infra),
  );
  assert.equal(workspaceId, "ws-1");
  assert.deepEqual([...sources.keys()].sort(), ["src-app", "src-infra"]);
});

test("a panel that reads one source's table under another's id is refused", async () => {
  const err = await refused(
    resolveAndValidateDashboard(
      dashboard([
        { id: "requests", sourceId: "src-app", sql: "SELECT value FROM http_requests" },
        { id: "cpu", sourceId: "src-infra", sql: "SELECT value FROM http_requests" },
      ]),
      lookup(app, infra),
    ),
  );
  assert.equal(err.status, 400);
  assert.match(err.message, /^panel "cpu": /);
});

// --- The form ----------------------------------------------------------------

test("the form offers only the primary's workspace, and at most two more", () => {
  const other = makeSource("src-other", "t", { workspaceId: "ws-2" });
  const all = [app, infra, logs, other];
  assert.deepEqual(
    additionalSourceChoices(all, "src-app").map((s) => s.id),
    ["src-infra", "src-logs"],
  );
  assert.deepEqual(additionalSourceChoices(all, null), []);

  let picked = toggleAdditionalSource([], "src-infra", true);
  picked = toggleAdditionalSource(picked, "src-logs", true);
  assert.deepEqual(toggleAdditionalSource(picked, "src-x", true), picked);
  assert.deepEqual(toggleAdditionalSource(picked, "src-infra", false), ["src-logs"]);

  // Changing the primary drops what is no longer a valid other.
  assert.deepEqual(pruneAdditionalSources(picked, all, "src-infra"), ["src-logs"]);
  assert.deepEqual(pruneAdditionalSources(picked, all, "src-other"), []);
});
