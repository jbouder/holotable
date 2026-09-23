import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatLatency,
  hasFinding,
  readOnlyHeadline,
  readOnlyTone,
  shortVersion,
  type SourceTestResult,
  summarizeTables,
} from "@/lib/source-test";

const PASSING: SourceTestResult = {
  ok: true,
  message: "connection succeeded",
  latency: { connectMs: 12, queryMs: 3 },
  server: { version: "PostgreSQL 16.4 (Debian 16.4-1) on x86_64", timescaledb: "2.17.2" },
  role: {
    currentUser: "holo_ro",
    sessionUser: "holo_ro",
    searchPath: '"metrics", public',
  },
  readOnly: {
    verdict: "refused",
    detail: "cannot execute CREATE TABLE in a read-only transaction",
  },
  tables: [
    { table: "cpu", reachable: true },
    { table: "mem", reachable: true },
  ],
};

/* -------------------------------------------------------------------------- */
/* Reading the facts                                                          */
/* -------------------------------------------------------------------------- */

test("a version string is reduced to the part that fits on a line", () => {
  assert.equal(shortVersion(PASSING.server?.version ?? ""), "PostgreSQL 16.4");
  assert.equal(shortVersion("PostgreSQL 15.2"), "PostgreSQL 15.2");
});

test("an unfamiliar version is truncated, never dropped", () => {
  // An unrecognised server is exactly when the operator wants its own words.
  const odd = "SomeProxy/experimental build ".repeat(10);
  const short = shortVersion(odd);
  assert.ok(short.length <= 60);
  assert.ok(short.startsWith("SomeProxy"));
});

test("latency reads in the unit it belongs to", () => {
  assert.equal(formatLatency(87.3), "87 ms");
  assert.equal(formatLatency(1234.7), "1.2 s");
  assert.equal(formatLatency(0), "0 ms");
  assert.equal(formatLatency(Number.NaN), "—");
  assert.equal(formatLatency(-1), "—");
});

/* -------------------------------------------------------------------------- */
/* The read-only verdict                                                      */
/* -------------------------------------------------------------------------- */

test("a write the server accepted is a danger, not a caveat", () => {
  // The transaction was opened READ ONLY. A write that goes through means the
  // assumption every downstream guarantee rests on is false for this source.
  assert.equal(readOnlyTone("accepted"), "danger");
  assert.equal(readOnlyTone("refused"), "ok");
  assert.equal(readOnlyTone("unknown"), "warning");
});

test("each verdict says which of the three things happened", () => {
  assert.match(readOnlyHeadline("refused"), /refused a write/);
  assert.match(readOnlyHeadline("accepted"), /can write/);
  assert.match(readOnlyHeadline("unknown"), /not proven/);
});

/* -------------------------------------------------------------------------- */
/* Tables                                                                     */
/* -------------------------------------------------------------------------- */

test("the table summary counts rather than lists", () => {
  assert.equal(summarizeTables(PASSING.tables ?? []), "All 2 tables readable");
  assert.equal(summarizeTables([{ table: "cpu", reachable: true }]), "1 table readable");
  assert.equal(summarizeTables([]), "No tables are allowlisted");
  assert.equal(
    summarizeTables([
      { table: "cpu", reachable: true },
      { table: "gone", reachable: false, error: "relation does not exist" },
    ]),
    "1 of 2 tables readable",
  );
});

/* -------------------------------------------------------------------------- */
/* What counts as something to act on                                         */
/* -------------------------------------------------------------------------- */

test("a clean result has nothing to act on", () => {
  assert.equal(hasFinding(PASSING), false);
});

test("a connection that failed is a finding", () => {
  assert.equal(hasFinding({ ok: false, message: "ECONNREFUSED" }), true);
});

test("a writable role is a finding even though the test passed", () => {
  // This is the case the old one-line "connection succeeded" hid.
  assert.equal(
    hasFinding({
      ...PASSING,
      readOnly: { verdict: "accepted", detail: "it worked" },
    }),
    true,
  );
});

test("a read-only probe that could not run is a finding, not a pass", () => {
  assert.equal(
    hasFinding({
      ...PASSING,
      readOnly: { verdict: "unknown", detail: "no temp schema" },
    }),
    true,
  );
});

test("an allowlisted table that is gone is a finding", () => {
  assert.equal(
    hasFinding({
      ...PASSING,
      tables: [
        { table: "cpu", reachable: true },
        { table: "gone", reachable: false, error: "relation does not exist" },
      ],
    }),
    true,
  );
});

test("an old-shaped result with no probe and no tables still passes cleanly", () => {
  // The route answers with whatever the collector produced; a result carrying
  // only `ok` must not be reported as a finding it does not describe.
  assert.equal(hasFinding({ ok: true, message: "connection succeeded" }), false);
});
