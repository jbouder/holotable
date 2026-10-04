import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogView, searchCatalog, setColumnExposure } from "@/lib/catalog/browse";
import { catalogHealth } from "@/lib/catalog/health";
import { SourceConfig, type SourceRecord } from "@/lib/registry";
import { sourceListing } from "@/lib/source-listing";
import { validateSql } from "@/lib/sql/safety";
import { buildCatalogPrompt } from "@/lib/timescaledb/catalog";

/**
 * The catalog browser (#123): what each role is sent, how search narrows the
 * tree, and the one edit it makes, followed through to the two places that
 * edit has to reach — the prompt and the guard.
 */

const config = SourceConfig.parse({
  host: "timescaledb.internal",
  port: 5432,
  database: "holotable",
  schema: "metrics",
  ssl: true,
  tables: [
    {
      name: "http_requests",
      description: "One row per request",
      timeField: "ts",
      columns: [
        { name: "ts", type: "timestamp with time zone" },
        { name: "status", type: "smallint", description: "HTTP status code" },
        { name: "secret_client_ip", type: "inet", exposed: false },
      ],
    },
    {
      name: "cpu_usage",
      columns: [
        { name: "observed_at", type: "timestamp with time zone" },
        { name: "pct", type: "double precision" },
      ],
    },
  ],
});

const source: SourceRecord = {
  id: "src-metrics",
  workspaceId: "ws-1",
  name: "Metrics",
  kind: "timescaledb",
  config,
  secretRef: "TS_SECRET_METRICS",
  catalogRefreshedAt: new Date().toISOString(),
  catalogMissingTables: ["cpu_usage"],
  createdBy: "user-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  tombstonedAt: null,
};

const CONNECTION = ["timescaledb.internal", "5432", "TS_SECRET_METRICS"];

test("a source admin sees every column with its flag", () => {
  const view = catalogView(source, catalogHealth(source), true);
  assert.equal(view.canManage, true);
  const ip = view.tables[0].columns.find((c) => c.name === "secret_client_ip");
  assert.equal(ip?.exposed, false);
  assert.deepEqual(view.missingTables, ["cpu_usage"]);
});

test("anyone else sees the exposed columns only, and no connection detail", () => {
  const view = catalogView(source, catalogHealth(source), false);
  assert.equal(view.canManage, false);
  const serialized = JSON.stringify(view);
  for (const leak of ["secret_client_ip", ...CONNECTION]) {
    assert.equal(serialized.includes(leak), false, `the viewer catalog leaked ${leak}`);
  }
  assert.deepEqual(
    view.tables[0].columns.map((c) => c.name),
    ["ts", "status"],
  );
});

test("the viewer's source listing names the source and nothing about reaching it", () => {
  const listing = sourceListing(source);
  assert.deepEqual(Object.keys(listing).sort(), [
    "id",
    "name",
    "schema",
    "tableCount",
    "tombstonedAt",
    "workspaceId",
  ]);
  const serialized = JSON.stringify(listing);
  for (const leak of ["secret_client_ip", "holotable", ...CONNECTION]) {
    assert.equal(serialized.includes(leak), false, `the listing leaked ${leak}`);
  }
  assert.equal(listing.tableCount, 2);
});

test("search keeps a matching table whole, and narrows the rest to their matching columns", () => {
  const tables = config.tables;
  assert.equal(searchCatalog(tables, "").length, 2);
  assert.equal(searchCatalog(tables, "   ").length, 2);

  const byTable = searchCatalog(tables, "HTTP_req");
  assert.equal(byTable.length, 1);
  assert.equal(byTable[0].tableMatched, true);
  assert.equal(byTable[0].columns.length, 3);

  // By column name, across tables.
  const ts = searchCatalog(tables, "observed");
  assert.deepEqual(
    ts.map((m) => [m.table.name, m.columns.map((c) => c.name)]),
    [["cpu_usage", ["observed_at"]]],
  );

  // By type, and by description.
  assert.deepEqual(
    searchCatalog(tables, "timestamp").map((m) => m.columns.map((c) => c.name)),
    [["ts"], ["observed_at"]],
  );
  assert.deepEqual(
    searchCatalog(tables, "status code").map((m) => m.columns.map((c) => c.name)),
    [["status"]],
  );
  // A table description counts as the table matching.
  assert.equal(searchCatalog(tables, "one row per")[0].tableMatched, true);

  assert.deepEqual(searchCatalog(tables, "nothing like this"), []);
});

test("hiding a column writes exposed: false, and exposing it removes the flag", () => {
  const hidden = setColumnExposure(config, "http_requests", "status", false);
  assert.ok(hidden);
  assert.deepEqual(hidden.tables[0].columns[1], {
    name: "status",
    type: "smallint",
    description: "HTTP status code",
    exposed: false,
  });
  // Nothing else moved.
  assert.deepEqual(hidden.tables[1], config.tables[1]);
  assert.deepEqual(hidden.tables[0].columns[0], config.tables[0].columns[0]);
  assert.equal(SourceConfig.safeParse(hidden).success, true);

  const exposed = setColumnExposure(config, "http_requests", "secret_client_ip", true);
  assert.ok(exposed);
  assert.equal("exposed" in exposed.tables[0].columns[2], false);
});

test("a table or column that is not in the catalog is refused, not invented", () => {
  assert.equal(setColumnExposure(config, "users", "email", false), null);
  assert.equal(setColumnExposure(config, "http_requests", "email", false), null);
});

test("a toggle takes effect in the prompt and in the guard", async () => {
  const sql = "SELECT ts, status FROM http_requests";
  assert.equal((await validateSql(sql, config)).ok, true);
  assert.match(buildCatalogPrompt(source), /^ {4}status smallint/m);

  const hidden = SourceConfig.parse(
    setColumnExposure(config, "http_requests", "status", false),
  );
  const refused = await validateSql(sql, hidden);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "column");
  assert.doesNotMatch(buildCatalogPrompt({ ...source, config: hidden }), /status/);

  const back = SourceConfig.parse(
    setColumnExposure(hidden, "http_requests", "status", true),
  );
  assert.equal((await validateSql(sql, back)).ok, true);
});
