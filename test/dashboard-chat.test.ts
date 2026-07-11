import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatQueryPlan } from "@/lib/ai/chat";
import { SourceConfig, type SourceRecord } from "@/lib/registry";
import type { Dashboard } from "@/lib/ir";

const config = SourceConfig.parse({
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
        { name: "duration_ms", type: "double precision" },
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
  secretRef: "TS_METRICS",
  createdBy: "user-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  tombstonedAt: null,
};

const dashboard = {
  title: "Traffic",
  timeRange: { from: "now-1h", to: "now" },
  refreshIntervalMs: 15_000,
  panels: [],
} as unknown as Dashboard;

test("rejects a source not available on the dashboard", () => {
  const r = buildChatQueryPlan({
    dashboard,
    sources: [source],
    args: { sourceId: "src-other", sql: "SELECT count(*) FROM http_requests" },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /src-metrics/);
});

test("rejects non-SELECT SQL", () => {
  const r = buildChatQueryPlan({
    dashboard,
    sources: [source],
    args: { sourceId: "src-metrics", sql: "DELETE FROM http_requests" },
  });
  assert.equal(r.ok, false);
});

test("rejects a table not in the source allowlist", () => {
  const r = buildChatQueryPlan({
    dashboard,
    sources: [source],
    args: { sourceId: "src-metrics", sql: "SELECT * FROM secrets" },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /allowlist/);
});

test("builds a guarded plan with server-injected time range for time-series", () => {
  const now = new Date("2026-07-11T12:00:00.000Z");
  const r = buildChatQueryPlan({
    dashboard,
    sources: [source],
    args: {
      sourceId: "src-metrics",
      sql: "SELECT time_bucket('1 minute', ts) AS minute, count(*) AS c FROM http_requests GROUP BY minute ORDER BY minute",
      timeField: "minute",
    },
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    // The server owns the window: exactly the two bound time params are injected.
    assert.equal(r.plan.params.length, 2);
    assert.match(r.plan.sql, /_holo/);
    assert.match(r.plan.sql, /_holo\.minute >= \$1::timestamptz/);
    assert.match(r.plan.sql, /LIMIT/);
    assert.equal(r.source.id, "src-metrics");
    void now;
  }
});

test("builds a plan with no time filter when timeField is omitted (scalar)", () => {
  const r = buildChatQueryPlan({
    dashboard,
    sources: [source],
    args: {
      sourceId: "src-metrics",
      sql: "SELECT count(*) AS total FROM http_requests",
    },
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.plan.params.length, 0);
    assert.doesNotMatch(r.plan.sql, /timestamptz/);
    assert.match(r.plan.sql, /LIMIT/);
  }
});
