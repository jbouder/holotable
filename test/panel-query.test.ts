import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { PanelQuery, TimeRange } from "@/lib/ir";
import {
  formatElapsed,
  queryRequest,
  runPanelQuery,
  checkSubject,
  runSubject,
  summarizeResult,
  validatePanelSql,
} from "@/lib/panel-query";

const QUERY: PanelQuery = {
  sourceId: "src-1",
  sql: "SELECT ts, value FROM metrics",
  timeField: "ts",
};
const RANGE: TimeRange = { from: "now-15m", to: "now" };

interface Call {
  url: string;
  body: unknown;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Record every request and answer each with the next canned response. */
function stubFetch(responses: Response[]): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next;
  }) as typeof fetch;
  return calls;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

test("the query request carries the source id, sql, time field and range — nothing else", () => {
  assert.deepEqual(queryRequest(QUERY, RANGE), {
    sourceId: "src-1",
    sql: "SELECT ts, value FROM metrics",
    timeField: "ts",
    timeRange: RANGE,
  });
});

test("the request omits an absent time field rather than inventing one", () => {
  const request = queryRequest({ sourceId: "s", sql: "SELECT 1 AS v" }, RANGE);
  assert.equal(request.timeField, undefined);
  assert.deepEqual(Object.keys(request).sort(), [
    "sourceId",
    "sql",
    "timeField",
    "timeRange",
  ]);
});

test("the range stays relative — the server resolves it, not the client", () => {
  const { timeRange } = queryRequest(QUERY, { from: "now-6h", to: "now" });
  assert.deepEqual(timeRange, { from: "now-6h", to: "now" });
});

test("a successful run returns the rows and how long it took", async () => {
  const calls = stubFetch([
    jsonResponse({ columns: ["ts", "value"], rows: [{ ts: 1, value: 2 }] }),
  ]);
  const outcome = await runPanelQuery(QUERY, RANGE);
  assert.equal(calls[0].url, "/api/query");
  assert.deepEqual(calls[0].body, queryRequest(QUERY, RANGE));
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.rows.columns, ["ts", "value"]);
  assert.equal(outcome.rows.rows.length, 1);
  assert.ok(outcome.elapsedMs >= 0);
});

test("a result body of the wrong shape becomes empty rows, not a crash", async () => {
  stubFetch([jsonResponse({ columns: "nope" })]);
  const outcome = await runPanelQuery(QUERY, RANGE);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.rows, { columns: [], rows: [] });
});

test("a failed statement keeps its message and its actionable kind", async () => {
  stubFetch([
    jsonResponse(
      { error: 'column "nope" does not exist', kind: "statement" },
      { status: 400 },
    ),
  ]);
  const outcome = await runPanelQuery(QUERY, RANGE);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.error.kind, "statement");
  assert.match(outcome.error.error, /does not exist/);
});

test("an infrastructure failure stays opaque", async () => {
  stubFetch([
    jsonResponse(
      { error: "boom", kind: "infrastructure", requestId: "req-1" },
      {
        status: 500,
      },
    ),
  ]);
  const outcome = await runPanelQuery(QUERY, RANGE);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.error.kind, "infrastructure");
  assert.equal(outcome.error.requestId, "req-1");
});

test("a transport failure is reported rather than thrown", async () => {
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  const outcome = await runPanelQuery(QUERY, RANGE);
  assert.equal(outcome.ok, false);
});

test("validation posts only the source id and the sql", async () => {
  const calls = stubFetch([jsonResponse({ ok: true })]);
  const check = await validatePanelSql({ sourceId: "src-1", sql: QUERY.sql });
  assert.equal(calls[0].url, "/api/sql/validate");
  assert.deepEqual(calls[0].body, { sourceId: "src-1", sql: QUERY.sql });
  assert.deepEqual(check, { ok: true });
});

test("a rejected statement is presented as the author's query to fix", async () => {
  stubFetch([jsonResponse({ ok: false, error: 'table "secrets" is not allowlisted' })]);
  const check = await validatePanelSql({
    sourceId: "src-1",
    sql: "SELECT * FROM secrets",
  });
  assert.equal(check.ok, false);
  if (check.ok) return;
  assert.equal(check.error.kind, "statement");
  assert.equal(check.error.error, 'table "secrets" is not allowlisted');
});

test("a rejection with no message still says something", async () => {
  stubFetch([jsonResponse({ ok: false })]);
  const check = await validatePanelSql({ sourceId: "src-1", sql: "SELECT 1" });
  assert.equal(check.ok, false);
  if (check.ok) return;
  assert.equal(check.error.error, "invalid sql");
});

test("a denied validation keeps the route's own kind", async () => {
  stubFetch([
    jsonResponse({ error: "forbidden", kind: "authorization" }, { status: 403 }),
  ]);
  const check = await validatePanelSql({ sourceId: "src-1", sql: "SELECT 1" });
  assert.equal(check.ok, false);
  if (check.ok) return;
  assert.equal(check.error.kind, "authorization");
});

test("a check is retired by the sql or the source, and nothing else", () => {
  const subject = checkSubject(QUERY);
  assert.notEqual(subject, checkSubject({ ...QUERY, sql: `${QUERY.sql} LIMIT 1` }));
  assert.notEqual(subject, checkSubject({ ...QUERY, sourceId: "src-2" }));
  // The guard never reads the time field, so it cannot change the verdict.
  assert.equal(subject, checkSubject({ ...QUERY, timeField: "other" }));
});

test("a result is retired by the time field and the window as well", () => {
  const subject = runSubject(QUERY, RANGE);
  assert.notEqual(subject, runSubject({ ...QUERY, timeField: "other" }, RANGE));
  assert.notEqual(subject, runSubject(QUERY, { from: "now-6h", to: "now" }));
  assert.equal(subject, runSubject({ ...QUERY }, { ...RANGE }));
});

test("two questions cannot collide into one subject", () => {
  // Serialized, not joined: "a" + "b\nc" must not read as "a\nb" + "c".
  assert.notEqual(
    checkSubject({ sourceId: "a", sql: "b\nc" }),
    checkSubject({ sourceId: "a\nb", sql: "c" }),
  );
});

test("the result summary reads as a sentence", () => {
  assert.equal(summarizeResult(1, 312), "1 row in 312 ms");
  assert.equal(summarizeResult(0, 12), "0 rows in 12 ms");
  assert.equal(summarizeResult(124, 1240), "124 rows in 1.2 s");
});

test("elapsed time switches to seconds at a second", () => {
  assert.equal(formatElapsed(999.4), "999 ms");
  assert.equal(formatElapsed(1000), "1.0 s");
});
