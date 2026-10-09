import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type CatalogDiff,
  diffCatalog,
  droppedHiddenColumns,
  isUnchanged,
  summarizeCatalogDiff,
} from "@/lib/catalog/refresh";
import { type SqlSourceConfig, TimescaleDbConfig } from "@/lib/registry";
import { refreshDigest } from "@/lib/timescaledb/catalog";

/**
 * The reviewed refresh (#123): what the preview reports, and the digest that
 * keeps the apply step to exactly what was reviewed.
 */

const stored = TimescaleDbConfig.parse({
  host: "postgres",
  port: 5432,
  database: "holotable",
  schema: "metrics",
  ssl: false,
  tables: [
    {
      name: "http_requests",
      timeField: "ts",
      columns: [
        { name: "ts", type: "timestamp with time zone" },
        { name: "status", type: "smallint" },
        { name: "client_ip", type: "inet", exposed: false },
        { name: "path", type: "text" },
      ],
    },
    {
      name: "cpu_usage",
      columns: [
        { name: "ts", type: "timestamp with time zone" },
        { name: "pct", type: "double precision" },
      ],
    },
    {
      name: "legacy_events",
      columns: [{ name: "id", type: "integer" }],
    },
  ],
});

function withTables(tables: SqlSourceConfig["tables"]): SqlSourceConfig {
  return TimescaleDbConfig.parse({ ...stored, tables });
}

test("a refresh that finds the same catalog reports no changes", () => {
  const diff = diffCatalog(
    { config: stored, catalogMissingTables: [] },
    { config: stored, missingTables: [] },
  );
  assert.equal(isUnchanged(diff), true);
  assert.match(summarizeCatalogDiff(diff), /^No changes since the last refresh/);
});

test("added, removed and retyped columns are reported per table, by name", () => {
  const [http, cpu, legacy] = stored.tables;
  const next = withTables([
    {
      ...http,
      columns: [
        { name: "ts", type: "timestamp with time zone" },
        // Retyped.
        { name: "status", type: "integer" },
        // `client_ip` (hidden) and `path` are gone; `region` is new.
        { name: "region", type: "text" },
      ],
    },
    cpu,
    legacy,
  ]);

  const diff = diffCatalog(
    { config: stored, catalogMissingTables: [] },
    { config: next, missingTables: [] },
  );

  assert.deepEqual(diff.tables, [
    {
      table: "http_requests",
      added: [{ name: "region", type: "text" }],
      removed: [
        { name: "client_ip", type: "inet", exposed: false },
        { name: "path", type: "text" },
      ],
      retyped: [{ name: "status", from: "smallint", to: "integer" }],
    },
  ]);
  assert.equal(
    summarizeCatalogDiff(diff),
    "1 column added, 2 columns removed, 1 column type changed.",
  );
  // A hidden column that is dropped would come back exposed; the review says so.
  assert.deepEqual(droppedHiddenColumns(diff), ["http_requests.client_ip"]);
});

test("a missing table is an error, reported once, and never as removed columns", () => {
  // `refreshCatalog()` keeps a missing table's last known columns.
  const diff = diffCatalog(
    { config: stored, catalogMissingTables: [] },
    { config: stored, missingTables: ["legacy_events"] },
  );
  assert.deepEqual(diff.missingTables, ["legacy_events"]);
  assert.deepEqual(diff.tables, []);
  assert.equal(isUnchanged(diff), false);
  assert.equal(summarizeCatalogDiff(diff), "1 table missing.");
});

test("a table the last refresh could not find, found again, is reported as restored", () => {
  const diff = diffCatalog(
    { config: stored, catalogMissingTables: ["legacy_events", "cpu_usage"] },
    { config: stored, missingTables: ["cpu_usage"] },
  );
  assert.deepEqual(diff.restoredTables, ["legacy_events"]);
  assert.deepEqual(diff.missingTables, ["cpu_usage"]);
  assert.equal(summarizeCatalogDiff(diff), "1 table missing, 1 table found again.");
});

test("the summary counts across tables and pluralizes", () => {
  const diff: CatalogDiff = {
    missingTables: ["a", "b"],
    restoredTables: [],
    tables: [
      { table: "t1", added: [{ name: "x", type: "text" }], removed: [], retyped: [] },
      { table: "t2", added: [{ name: "y", type: "text" }], removed: [], retyped: [] },
    ],
  };
  assert.equal(summarizeCatalogDiff(diff), "2 tables missing, 2 columns added.");
});

test("the digest is stable for the same result and changes with anything that would be stored", () => {
  const base = { config: stored, missingTables: [] };
  const digest = refreshDigest(base);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(
    refreshDigest({ config: TimescaleDbConfig.parse(stored), missingTables: [] }),
    digest,
  );

  // A new column, a missing table, and an exposure flag each change it.
  const [http, ...rest] = stored.tables;
  const added = withTables([
    { ...http, columns: [...http.columns, { name: "region", type: "text" }] },
    ...rest,
  ]);
  const hidden = withTables([
    {
      ...http,
      columns: http.columns.map((c) =>
        c.name === "path" ? { ...c, exposed: false } : c,
      ),
    },
    ...rest,
  ]);
  const digests = new Set([
    digest,
    refreshDigest({ config: added, missingTables: [] }),
    refreshDigest({ config: stored, missingTables: ["legacy_events"] }),
    refreshDigest({ config: hidden, missingTables: [] }),
  ]);
  assert.equal(digests.size, 4);
});
