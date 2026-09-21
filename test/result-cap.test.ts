import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ResultCollector,
  formatBytes,
  serializedRowBytes,
} from "@/lib/timescaledb/result-cap";

/** A row whose JSON is `n` bytes wide, give or take the framing. */
function wideRow(n: number, i = 0): Record<string, unknown> {
  return { ts: `2024-01-01T00:00:${String(i).padStart(2, "0")}Z`, blob: "x".repeat(n) };
}

test("serializedRowBytes measures UTF-8 bytes of the JSON the client receives", () => {
  assert.equal(serializedRowBytes({ a: 1 }), '{"a":1}'.length);
  // A 3-byte character counts as 3 bytes, not 1 UTF-16 code unit.
  assert.equal(serializedRowBytes({ a: "€" }), Buffer.byteLength('{"a":"€"}', "utf8"));
  // Dates have already been converted to ISO strings by the time rows are measured.
  assert.equal(
    serializedRowBytes({ ts: "2024-01-01T00:00:00.000Z" }),
    '{"ts":"2024-01-01T00:00:00.000Z"}'.length,
  );
});

test("a result under the cap is kept whole and in order", () => {
  const c = new ResultCollector(10_000);
  const rows = [wideRow(10, 1), wideRow(20, 2), wideRow(30, 3)];
  for (const r of rows) assert.equal(c.push(r), true);
  assert.equal(c.exceeded, false);
  assert.deepEqual(c.rows, rows);
  assert.equal(c.seen, 3);
  assert.equal(
    c.bytes,
    rows.reduce((n, r) => n + serializedRowBytes(r), 0),
  );
});

test("a result exactly at the cap is allowed; one byte over is not", () => {
  const row = { a: "xyz" }; // '{"a":"xyz"}' = 11 bytes
  const size = serializedRowBytes(row);
  const exact = new ResultCollector(size * 2);
  assert.equal(exact.push(row), true);
  assert.equal(exact.push(row), true);
  assert.equal(exact.exceeded, false);

  const over = new ResultCollector(size * 2 - 1);
  assert.equal(over.push(row), true);
  assert.equal(over.push(row), false);
  assert.equal(over.exceeded, true);
});

test("crossing the cap stops accumulation: memory stays bounded by the cap", () => {
  const cap = 1_000;
  const c = new ResultCollector(cap);
  let pushed = 0;
  // Far more rows than fit; simulates a server that keeps streaming after the
  // cap is crossed (the row LIMIT is still what stops it upstream).
  for (let i = 0; i < 500; i++) {
    if (c.push(wideRow(100, i))) pushed += 1;
  }
  assert.equal(c.exceeded, true);
  assert.ok(pushed > 0 && pushed < 500);
  assert.equal(c.rows.length, pushed, "the row that crossed the cap is not kept");
  assert.ok(c.bytes <= cap, `kept ${c.bytes} bytes, cap ${cap}`);
  assert.equal(c.seen, 500, "later rows are counted but discarded");
});

test("the overflow message names the limit, its variable, and a remedy", () => {
  const c = new ResultCollector(4 * 1024 * 1024);
  const msg = c.exceededMessage();
  assert.match(msg, /MAX_RESULT_BYTES/);
  assert.match(msg, /4 MiB/);
  assert.match(msg, /time range|time_bucket|fewer columns/);
});

test("a single row wider than the cap fails on that row with nothing kept", () => {
  const c = new ResultCollector(64);
  assert.equal(c.push(wideRow(500)), false);
  assert.equal(c.exceeded, true);
  assert.deepEqual(c.rows, []);
  assert.match(c.exceededMessage(), /first 0 rows/);
});

test("the collector rejects a non-positive cap rather than admitting everything", () => {
  assert.throws(() => new ResultCollector(0), /positive/);
  assert.throws(() => new ResultCollector(Number.NaN), /positive/);
  assert.throws(() => new ResultCollector(-1), /positive/);
});

test("formatBytes renders whole MiB, fractional MiB, KiB and bytes", () => {
  assert.equal(formatBytes(4 * 1024 * 1024), "4 MiB");
  assert.equal(formatBytes(1.5 * 1024 * 1024), "1.5 MiB");
  assert.equal(formatBytes(512 * 1024), "512 KiB");
  assert.equal(formatBytes(900), "900 B");
});
