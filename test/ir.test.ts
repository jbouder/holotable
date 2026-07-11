import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Dashboard,
  Panel,
  TimeExpr,
  safeParseDashboard,
  parseDashboard,
} from "@/lib/ir";

const validPanel = {
  id: "p1",
  title: "Requests",
  viz: "line" as const,
  query: { sourceId: "src-1", sql: "SELECT ts, count(*) AS c FROM http_requests GROUP BY ts", timeField: "ts" },
  format: "number" as const,
  layout: { x: 0, y: 0, w: 6, h: 4 },
};

const validDashboard = {
  title: "Overview",
  timeRange: { from: "now-1h", to: "now" },
  refreshIntervalMs: 15_000,
  panels: [validPanel],
};

test("accepts a valid dashboard", () => {
  const parsed = parseDashboard(validDashboard);
  assert.equal(parsed.title, "Overview");
  assert.equal(parsed.panels.length, 1);
});

test("rejects unknown top-level keys (strict)", () => {
  const res = safeParseDashboard({ ...validDashboard, extra: true });
  assert.equal(res.success, false);
});

test("rejects unknown panel keys (strict)", () => {
  const res = safeParseDashboard({
    ...validDashboard,
    panels: [{ ...validPanel, color: "red" }],
  });
  assert.equal(res.success, false);
});

test("rejects duplicate panel ids", () => {
  const res = safeParseDashboard({
    ...validDashboard,
    panels: [validPanel, { ...validPanel, title: "Dup" }],
  });
  assert.equal(res.success, false);
  if (!res.success) {
    assert.match(JSON.stringify(res.error.issues), /duplicate panel id/);
  }
});

test("rejects empty panels array", () => {
  const res = safeParseDashboard({ ...validDashboard, panels: [] });
  assert.equal(res.success, false);
});

test("rejects refresh interval below 1s", () => {
  const res = safeParseDashboard({ ...validDashboard, refreshIntervalMs: 100 });
  assert.equal(res.success, false);
});

test("rejects invalid viz type", () => {
  const res = Panel.safeParse({ ...validPanel, viz: "scatter" });
  assert.equal(res.success, false);
});

test("timeField is optional on a panel query", () => {
  const res = Panel.safeParse({
    ...validPanel,
    query: { sourceId: "s", sql: "SELECT 1 AS v" },
  });
  assert.equal(res.success, true);
});

test("TimeExpr accepts relative and ISO forms", () => {
  for (const good of ["now", "now-15m", "now-1h", "now-24h", "now-7d", "2024-01-02T03:04:05Z"]) {
    assert.equal(TimeExpr.safeParse(good).success, true, good);
  }
});

test("TimeExpr rejects malformed forms", () => {
  for (const bad of ["later", "now-1y", "now +1h", "1h", "DROP", ""]) {
    assert.equal(TimeExpr.safeParse(bad).success, false, bad);
  }
});

test("Dashboard type is the LLM generation schema", async () => {
  const { DashboardGenerationSchema } = await import("@/lib/ir");
  assert.equal(DashboardGenerationSchema, Dashboard);
});
