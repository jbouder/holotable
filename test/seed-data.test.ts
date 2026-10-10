import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BACKFILL_CHUNK_ROWS,
  backfillBatchTimes,
  appLogRows,
  backfillChunks,
  backfillStart,
  HOSTS,
  HTTP_ROWS_PER_BATCH,
  httpRequestRows,
  parseBackfill,
  requestLatency,
  systemMetricRows,
} from "../scripts/lib/seed-data";

const NOW = Date.UTC(2026, 9, 4, 12);
const HOUR = 3_600_000;

/** A deterministic random source, so failures replay. */
function seeded(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2 ** 31;
    return s / 2 ** 31;
  };
}

test("SEED_BACKFILL parses s, m, h and d, and unset means no backfill", () => {
  assert.equal(parseBackfill(undefined), null);
  assert.equal(parseBackfill(""), null);
  assert.equal(parseBackfill("  "), null);
  assert.equal(parseBackfill("45s"), 45_000);
  assert.equal(parseBackfill("30m"), 30 * 60_000);
  assert.equal(parseBackfill("6h"), 6 * HOUR);
  assert.equal(parseBackfill("1d"), 24 * HOUR);
  assert.equal(parseBackfill("7d"), 7 * 24 * HOUR);
});

test("an invalid SEED_BACKFILL is an error that names the variable", () => {
  for (const bad of ["6", "6 h", "-1h", "1.5h", "1w", "now-6h", "0h", "8d", "abc"]) {
    assert.throws(() => parseBackfill(bad), /SEED_BACKFILL/, bad);
  }
});

test("batch times run at the live cadence, oldest first, ending one interval before now", () => {
  const times = backfillBatchTimes(NOW - 10_000, NOW, 2_000);
  assert.deepEqual(times, [
    NOW - 10_000,
    NOW - 8_000,
    NOW - 6_000,
    NOW - 4_000,
    NOW - 2_000,
  ]);
  assert.deepEqual(backfillBatchTimes(NOW, NOW, 2_000), []);
  assert.deepEqual(backfillBatchTimes(NOW - 10_000, NOW, 0), []);
});

test("a six-hour backfill has the live loop's row counts, inside the window, in bounded chunks", () => {
  const interval = 2_000;
  const from = NOW - 6 * HOUR;
  const batches = (6 * HOUR) / interval;

  let http = 0;
  let chunks = 0;
  let previous = Number.NEGATIVE_INFINITY;
  for (const chunk of backfillChunks(
    httpRequestRows,
    from,
    NOW,
    interval,
    undefined,
    seeded(),
  )) {
    chunks++;
    assert.ok(chunk.length > 0 && chunk.length <= BACKFILL_CHUNK_ROWS);
    for (const row of chunk) {
      const ts = row.ts.getTime();
      assert.ok(
        ts >= from && ts < NOW,
        `row at ${row.ts.toISOString()} is outside the window`,
      );
      // Batches are oldest first; rows within one batch spread over a second.
      assert.ok(ts >= previous - 1_000);
      previous = ts;
    }
    http += chunk.length;
  }
  assert.equal(http, batches * HTTP_ROWS_PER_BATCH);
  assert.equal(chunks, Math.ceil(http / BACKFILL_CHUNK_ROWS));

  let system = 0;
  for (const chunk of backfillChunks(
    systemMetricRows,
    from,
    NOW,
    interval,
    1_000,
    seeded(2),
  )) {
    assert.ok(chunk.length <= 1_000);
    for (const row of chunk) {
      assert.ok(row.ts.getTime() >= from && row.ts.getTime() < NOW);
    }
    system += chunk.length;
  }
  assert.equal(system, batches * HOSTS.length);
});

test("no row lands before the window even when a batch sits on its edge", () => {
  const from = NOW - 4_000;
  for (const chunk of backfillChunks(
    httpRequestRows,
    from,
    NOW,
    2_000,
    10,
    () => 0.999,
  )) {
    for (const row of chunk) assert.ok(row.ts.getTime() >= from);
  }
});

test("a restart fills only the gap after the newest row, never doubling history", () => {
  // Empty table: the whole window.
  assert.equal(backfillStart(6 * HOUR, NOW, null), NOW - 6 * HOUR);
  // Down for an hour: just that hour.
  assert.equal(backfillStart(6 * HOUR, NOW, NOW - HOUR), NOW - HOUR + 1);
  // History older than the window: the window.
  assert.equal(backfillStart(6 * HOUR, NOW, NOW - 48 * HOUR), NOW - 6 * HOUR);
  // Already current: nothing left to write.
  const start = backfillStart(6 * HOUR, NOW, NOW - 500);
  assert.deepEqual(backfillBatchTimes(start, NOW, 2_000), []);
});

test("the live generators keep their shape", () => {
  const http = httpRequestRows(NOW, seeded(3));
  assert.equal(http.length, HTTP_ROWS_PER_BATCH);
  for (const row of http) {
    assert.ok(row.ts.getTime() <= NOW && row.ts.getTime() > NOW - 1_000);
    assert.ok([200, 404, 500].includes(row.status));
    assert.ok(row.duration_ms >= 1);
  }
  const system = systemMetricRows(NOW, seeded(4));
  assert.deepEqual(
    system.map((r) => r.host),
    HOSTS,
  );
  for (const row of system) {
    for (const pct of [row.cpu_pct, row.mem_pct, row.disk_pct]) {
      assert.ok(pct >= 1 && pct <= 100);
    }
  }
});

test("the hosts differ, so the demo's thresholds and states have something to show", () => {
  // Over many readings, each host's CPU and disk stay in its own range: a
  // quiet host, a busy one past the 70% warning step, and a disk past 85%.
  const random = seeded(7);
  const readings = Array.from({ length: 500 }, (_, i) =>
    systemMetricRows(NOW + i, random),
  );
  const mean = (host: string, key: "cpu_pct" | "disk_pct") => {
    const values = readings
      .flat()
      .filter((r) => r.host === host)
      .map((r) => r[key]);
    return values.reduce((a, b) => a + b, 0) / values.length;
  };
  assert.ok(mean("host-01", "cpu_pct") < 50);
  assert.ok(mean("host-03", "cpu_pct") > 70);
  assert.ok(mean("host-04", "disk_pct") > 85);
  assert.ok(mean("host-01", "disk_pct") < 60);
});

test("latency has a body, a slow route and a tail, so a histogram has a shape", () => {
  const random = seeded(11);
  const sample = (route: string, status = 200) =>
    Array.from({ length: 2000 }, () => requestLatency(route, status, random)).sort(
      (a, b) => a - b,
    );
  const fast = sample("/login");
  const search = sample("/search");
  const median = (xs: number[]) => xs[Math.floor(xs.length / 2)] ?? 0;
  assert.ok(median(fast) < 100, `median ${median(fast)}`);
  assert.ok(median(search) > median(fast) + 100);
  // About one in fifty is a tail past 600 ms.
  const tail = fast.filter((ms) => ms > 600).length / fast.length;
  assert.ok(tail > 0.005 && tail < 0.05, `tail ${tail}`);
  assert.ok(median(sample("/login", 500)) > median(fast) + 250);
});

test("log lines cover every level, each with a route and a request id", () => {
  const random = seeded(13);
  const lines = Array.from({ length: 400 }, (_, i) => appLogRows(NOW + i, random)).flat();
  const levels = new Set(lines.map((l) => l.level));
  assert.deepEqual([...levels].sort(), ["debug", "error", "info", "warn"]);
  for (const line of lines) {
    assert.match(line.request_id, /^[0-9a-f]{12}$/);
    assert.ok(line.message.includes(line.route), line.message);
    assert.ok(line.ts.getTime() <= NOW + 400);
  }
  const errors = lines.filter((l) => l.level === "error").length / lines.length;
  assert.ok(errors > 0.01 && errors < 0.1, `errors ${errors}`);
});
