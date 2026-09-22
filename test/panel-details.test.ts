import { test } from "node:test";
import assert from "node:assert/strict";
import type { Panel } from "@/lib/ir";
import { panelDetails } from "@/lib/panel-details";

function panel(overrides: Partial<Panel> = {}): Panel {
  return {
    id: "p1",
    title: "Requests",
    viz: "line",
    query: {
      sourceId: "src-1",
      sql: "SELECT ts, value FROM metrics",
      timeField: "ts",
    },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    ...overrides,
  };
}

test("exposes the sql, source id, time field and description", () => {
  const details = panelDetails(panel({ description: "requests per second" }));
  assert.deepEqual(details, {
    sql: "SELECT ts, value FROM metrics",
    sourceId: "src-1",
    timeField: "ts",
    description: "requests per second",
  });
});

test("copies the sql verbatim", () => {
  const sql = "SELECT\n  ts,\n  avg(value) AS v\nFROM metrics\nGROUP BY 1";
  assert.equal(panelDetails(panel({ query: { sourceId: "s", sql } })).sql, sql);
});

test("omits an absent time field and description rather than inventing one", () => {
  const details = panelDetails(panel({ query: { sourceId: "s", sql: "SELECT 1" } }));
  assert.equal(details.timeField, undefined);
  assert.equal(details.description, undefined);
});

test("never carries connection details smuggled onto the panel", () => {
  // The IR is strict, so this shape cannot be parsed — but a producer holding a
  // looser object must not be able to leak through the viewer either.
  const query: Record<string, unknown> = {
    sourceId: "src-1",
    sql: "SELECT 1",
    secret_ref: "vault://prod/db",
    connectionString: "postgresql://user:hunter2@db:5432/prod",
    password: "hunter2",
  };
  const smuggled = { ...panel(), query } as unknown as Panel;

  const details = panelDetails(smuggled);
  assert.deepEqual(Object.keys(details).sort(), [
    "description",
    "sourceId",
    "sql",
    "timeField",
  ]);
  assert.doesNotMatch(JSON.stringify(details), /hunter2|vault:\/\/|postgresql:\/\//);
});
