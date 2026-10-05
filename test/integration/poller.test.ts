import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closePool, query } from "@/lib/db/pg";
import { createSource } from "@/lib/db/repo";
import { type Dashboard, SPEC_VERSION } from "@/lib/ir";
import { getPoller, type PollerEvent } from "@/lib/poller/registry";
import { closeSourcePools } from "@/lib/timescaledb/pool";
import { grantRef, metricsSource, needsDb, ownerClient, unique } from "./support";

/*
 * One dashboard poller against real data (#87): the production executor, the
 * production source lookup in the config store, the guard, the plan and the
 * read-only execution, ticking over rows the test writes into the demo
 * `http_requests` hypertable. The first tick replaces; the next one appends
 * from each panel's cursor, its own bucket included, and a non-time panel is
 * replaced again.
 */

const WORKSPACE = unique("ws-poller");
const SERVICE = unique("it-poller");

after(async () => {
  if (!process.env.MIGRATE_TEST_DATABASE_URL) return;
  const owner = await ownerClient();
  await owner.query("DELETE FROM metrics.http_requests WHERE service = $1", [SERVICE]);
  await owner.end();
  await query("DELETE FROM sources WHERE workspace_id = $1", [WORKSPACE]);
  await closeSourcePools();
  await closePool();
});

/**
 * The minute every row is placed relative to, fixed once: computed per insert,
 * a minute boundary passing mid-test would move a batch into another bucket.
 */
const ANCHOR = new Date(Math.floor(Date.now() / 60_000) * 60_000);

/** `count` rows of `SERVICE` in the minute `minutesAgo` before {@link ANCHOR}. */
async function insertRequests(minutesAgo: number, count: number): Promise<void> {
  const owner = await ownerClient();
  try {
    await owner.query(
      `INSERT INTO metrics.http_requests (ts, service, route, status, duration_ms, bytes)
       SELECT $4::timestamptz - make_interval(mins => $2) + make_interval(secs => g),
              $1, '/it', 200, 10, 100
         FROM generate_series(1, $3) AS g`,
      [SERVICE, minutesAgo, count, ANCHOR],
    );
  } finally {
    await owner.end();
  }
}

/** Resolve with the events of the next `tick`, collected as they arrive. */
function nextTick(events: PollerEvent[]): Promise<PollerEvent[]> {
  const start = events.length;
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("no tick within 15s")), 15_000);
    const poll = setInterval(() => {
      const tick = events.findIndex((e, i) => i >= start && e.type === "tick");
      if (tick === -1) return;
      clearInterval(poll);
      clearTimeout(deadline);
      resolve(events.slice(start, tick + 1));
    }, 20);
  });
}

function panelEvent(events: PollerEvent[], panelId: string) {
  const event = events.find(
    (e) => e.type !== "tick" && "panelId" in e && e.panelId === panelId,
  );
  assert.ok(event, `no event for ${panelId} in ${JSON.stringify(events)}`);
  assert.equal(event.type, "panel", JSON.stringify(event));
  return event as Extract<PollerEvent, { type: "panel" }>;
}

test(
  "a poller tick against real rows replaces, then appends from the cursor",
  needsDb,
  async () => {
    const sourceId = unique("src-poller");
    grantRef("HT_IT_POLLER", WORKSPACE);
    const { config } = metricsSource({
      id: sourceId,
      workspaceId: WORKSPACE,
      secretRef: "HT_IT_POLLER",
    });
    await createSource({
      id: sourceId,
      workspaceId: WORKSPACE,
      name: "Poller source",
      config,
      secretRef: "HT_IT_POLLER",
      createdBy: "integration",
    });

    await insertRequests(3, 2);
    await insertRequests(2, 3);

    const spec: Dashboard = {
      specVersion: SPEC_VERSION,
      title: "Poller",
      timeRange: { from: "now-1h", to: "now" },
      refreshIntervalMs: 1_000,
      panels: [
        {
          id: "rate",
          title: "Requests",
          viz: "line",
          query: {
            sourceId,
            timeField: "minute",
            sql: `SELECT time_bucket('1 minute', ts) AS minute, count(*)::int AS requests
                FROM http_requests WHERE service = '${SERVICE}'
                GROUP BY minute ORDER BY minute`,
          },
          layout: { x: 0, y: 0, w: 6, h: 4 },
        },
        {
          id: "total",
          title: "Total",
          viz: "stat",
          query: {
            sourceId,
            sql: `SELECT count(*)::int AS total FROM http_requests WHERE service = '${SERVICE}'`,
          },
          layout: { x: 6, y: 0, w: 6, h: 4 },
        },
      ],
    };

    const events: PollerEvent[] = [];
    const poller = getPoller(unique("dash-poller"), 1, WORKSPACE, spec, {});
    const unsubscribe = poller.subscribe((event) => {
      events.push(event);
    });
    try {
      const first = await nextTick(events);
      const rate = panelEvent(first, "rate");
      assert.equal(rate.mode, "replace");
      assert.deepEqual(
        rate.rows.map((r) => r.requests),
        [2, 3],
      );
      assert.deepEqual(panelEvent(first, "total").rows, [{ total: 5 }]);
      const cursor = String(rate.rows[1].minute);

      // The newest bucket fills in, and a new one starts.
      await insertRequests(2, 1);
      await insertRequests(1, 4);

      // A tick may already have been in flight before the rows landed; wait
      // until one reflects them.
      let second: PollerEvent[] = [];
      for (let i = 0; i < 5; i++) {
        second = await nextTick(events);
        if (panelEvent(second, "total").rows[0]?.total === 10) break;
      }
      const appended = panelEvent(second, "rate");
      assert.equal(appended.mode, "append");
      assert.equal(appended.since, cursor);
      assert.equal(appended.timeField, "minute");
      // From the cursor on: the re-sent bucket with its new count, and the new one.
      assert.deepEqual(
        appended.rows.map((r) => [String(r.minute) >= cursor, r.requests]),
        [
          [true, 4],
          [true, 4],
        ],
      );
      assert.equal(String(appended.rows[0].minute), cursor);

      const total = panelEvent(second, "total");
      assert.equal(total.mode, "replace");
      assert.deepEqual(total.rows, [{ total: 10 }]);
    } finally {
      unsubscribe();
    }
    assert.equal(poller.isRunning, false, "the last subscriber leaving stops the poller");
  },
);
