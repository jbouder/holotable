import { test } from "node:test";
import assert from "node:assert/strict";
import type { TimeRange } from "@/lib/ir";
import { buildQueryPlanView, summarizeLimits } from "@/lib/query-plan";
import { buildExecutablePlan } from "@/lib/sql/safety";
import { sessionStatements } from "@/lib/timescaledb/client";

/**
 * What `/api/sql/plan` may say about an execution.
 *
 * Like `test/panel-details.test.ts`, this pins the field set: the plan view is
 * the second place a panel's internals are shown to a reader, and widening it
 * has to be a deliberate act rather than something a spread picks up.
 */

const RANGE: TimeRange = { from: "now-1h", to: "now" };
const FROM = new Date("2026-09-22T11:00:00.000Z");
const TO = new Date("2026-09-22T12:00:00.000Z");

const LIMITS = { maxRows: 5_000, statementTimeoutMs: 30_000, maxResultBytes: 4_194_304 };

function view(sql: string, timeField?: string) {
  return buildQueryPlanView({
    sql,
    timeField,
    timeRange: RANGE,
    plan: buildExecutablePlan({ sql, timeField, from: FROM, to: TO }),
    session: sessionStatements("metrics"),
    limits: LIMITS,
  });
}

test("the field set is exactly what a reader may see", () => {
  assert.deepEqual(Object.keys(view("SELECT 1 AS v")).sort(), [
    "executedSql",
    "maxResultBytes",
    "maxRows",
    "params",
    "session",
    "sql",
    "statementTimeoutMs",
    "timeField",
  ]);
});

test("the executed statement is the wrapper the server actually sends", () => {
  const plan = view("SELECT ts, v FROM m", "ts");
  assert.match(plan.executedSql, /SELECT \* FROM \(SELECT ts, v FROM m\) AS _holo/);
  assert.match(plan.executedSql, /_holo\.ts >= \$1::timestamptz/);
  assert.match(plan.executedSql, /LIMIT 5000/);
  // And the author's own statement is kept verbatim beside it.
  assert.equal(plan.sql, "SELECT ts, v FROM m");
});

test("the bound values are the resolved instants, labelled with what they came from", () => {
  const plan = view("SELECT ts, v FROM m", "ts");
  assert.deepEqual(plan.params, [
    { placeholder: "$1", value: FROM.toISOString(), from: "now-1h" },
    { placeholder: "$2", value: TO.toISOString(), from: "now" },
  ]);
});

test("a panel with no time field binds nothing", () => {
  const plan = view("SELECT count(*) AS v FROM m");
  assert.deepEqual(plan.params, []);
  assert.equal(plan.timeField, undefined);
  assert.doesNotMatch(plan.executedSql, /\$1/);
});

test("the session shown is the session that runs, read from the client itself", () => {
  const plan = view("SELECT 1 AS v");
  assert.deepEqual(plan.session, [
    "BEGIN TRANSACTION READ ONLY",
    'SET LOCAL search_path TO "metrics", public',
  ]);
});

test("the limits are the server's, not the caller's", () => {
  const plan = view("SELECT 1 AS v");
  assert.equal(plan.maxRows, LIMITS.maxRows);
  assert.equal(plan.statementTimeoutMs, LIMITS.statementTimeoutMs);
  assert.equal(plan.maxResultBytes, LIMITS.maxResultBytes);
  assert.equal(summarizeLimits(plan), "5,000 rows · 30 s · 4.0 MiB");
});

/**
 * The builder takes pieces rather than a source, so there is no field for a
 * credential to ride in on. Proven rather than asserted: feed it a leaky
 * statement and a leaky session and check that only what was passed comes back.
 */
test("nothing that was not passed in can appear in the view", () => {
  const leaky = {
    id: "src-1",
    host: "db.internal",
    port: 5432,
    user: "holotable",
    password: "hunter2",
    secret_ref: "vault://prod/db",
  };
  const plan = buildQueryPlanView({
    sql: "SELECT 1 AS v",
    timeRange: RANGE,
    plan: buildExecutablePlan({ sql: "SELECT 1 AS v", from: FROM, to: TO }),
    session: sessionStatements("public"),
    limits: LIMITS,
    // @ts-expect-error — a caller spreading a source would have to add a field.
    source: leaky,
  });
  const serialized = JSON.stringify(plan);
  for (const secret of ["hunter2", "vault://prod/db", "db.internal", "holotable"]) {
    assert.doesNotMatch(serialized, new RegExp(secret), secret);
  }
});

test("a schema that is not a plain identifier is refused, not interpolated", () => {
  assert.throws(() => sessionStatements('ev"il'), /invalid source schema/);
});
