import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedTables, SourceConfig, sourceCatalog } from "@/lib/registry";
import { catalogCompletions } from "@/lib/sql/completion";

/**
 * The catalog the SQL editor completes from crosses to the browser. What may
 * cross with it is the subject of these tests: the table allowlist, and
 * nothing that describes how to reach the database.
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
      ],
    },
  ],
});

test("the client projection carries the catalog and no connection detail", () => {
  const catalog = sourceCatalog(config);
  assert.deepEqual(Object.keys(catalog).sort(), ["schema", "tables"]);
  const serialized = JSON.stringify(catalog);
  for (const secret of ["timescaledb.internal", "5432", "holotable", "ssl"]) {
    assert.equal(
      serialized.includes(secret),
      false,
      `the projection leaked ${secret} to the client`,
    );
  }
});

test("the projection allowlists exactly what the full config does", () => {
  assert.deepEqual(allowedTables(sourceCatalog(config)), allowedTables(config));
  assert.deepEqual([...allowedTables(config)].sort(), [
    "http_requests",
    "metrics.http_requests",
  ]);
});

test("completions offer the allowlisted tables and their columns", () => {
  const { schema, defaultSchema } = catalogCompletions(sourceCatalog(config));
  assert.equal(defaultSchema, "metrics");
  assert.deepEqual(Object.keys(schema.metrics), ["http_requests"]);
  const table = schema.metrics.http_requests;
  assert.deepEqual(table.self, {
    label: "http_requests",
    type: "type",
    detail: "One row per request",
  });
  assert.deepEqual(table.children, [
    { label: "ts", type: "property", detail: "timestamp with time zone" },
    { label: "status", type: "property", detail: "smallint — HTTP status code" },
  ]);
});
