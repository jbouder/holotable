import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, mock, test } from "node:test";
import type { Dashboard } from "@/lib/ir";
import {
  DashboardPoller,
  type Listener,
  type PanelExecutor,
  type PollerEvent,
  setPollerJitterForTests,
} from "@/lib/poller/registry";
import { DROP_EVENT, serializationCount, STREAM_HEADERS } from "@/lib/sse";
import { subscriberStream } from "@/lib/sse-stream";
import { renderMetrics, resetMetricsForTests } from "@/lib/metrics";

/*
 * The dashboard stream under load (#489): one serialization per distinct
 * payload however many watch, a subscriber that stops reading dropped
 * without touching the others, and headers that keep a proxy from holding
 * frames back.
 */

setPollerJitterForTests(() => 0);
afterEach(() => mock.timers.reset());

const INTERVAL = 15_000;

function spec(): Dashboard {
  return {
    specVersion: 1,
    title: "t",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: INTERVAL,
    panels: [
      {
        id: "p1",
        title: "p1",
        viz: "line",
        query: { sourceId: "s1", sql: "SELECT ts, v FROM m", timeField: "ts" },
        layout: { x: 0, y: 0, w: 6, h: 4 },
      },
    ],
  };
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

test("a hundred viewers on one poller cost one serialization per payload per cycle", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let minute = 0;
  const executor: PanelExecutor = async (panel) => {
    minute++;
    return [
      {
        type: "panel",
        panelId: panel.id,
        mode: "replace",
        columns: ["ts", "v"],
        rows: Array.from({ length: minute }, (_, i) => ({
          ts: `2026-10-11T10:0${i}:00.000Z`,
          v: i,
        })),
      },
    ];
  };
  const poller = new DashboardPoller("d-sse", 1, "ws", spec(), {}, executor);
  const abort = new AbortController();
  const streams = Array.from({ length: 100 }, () =>
    subscriberStream({
      subscribe: (listener, resume) => poller.subscribe(listener, resume),
      resumeToken: null,
      slowTicks: 3,
      signal: abort.signal,
    }),
  );
  const before = serializationCount();
  await settle();
  // The first cycle: one replace (every viewer on the same, empty cursor)
  // and one tick.
  assert.equal(serializationCount() - before, 2);
  const after = serializationCount();
  mock.timers.tick(INTERVAL);
  await settle();
  // The next: one append for everyone on the same cursor, and one tick.
  assert.equal(serializationCount() - after, 2);
  abort.abort();
  assert.equal(streams.length, 100);
});

test("a viewer who stops reading is dropped after the slow cycles; one reading is not", async () => {
  const listeners: Listener[] = [];
  const subscribe = (listener: Listener) => {
    listeners.push(listener);
    return () => {
      listeners.splice(listeners.indexOf(listener), 1);
    };
  };
  resetMetricsForTests();
  const drops: string[] = [];
  const open = (who: string) =>
    subscriberStream({
      subscribe,
      resumeToken: null,
      slowTicks: 3,
      bufferBytes: 64,
      onDrop: (reason) => drops.push(`${who}:${reason}`),
    });
  const stalled = open("stalled");
  const reading = open("reading");
  const reader = reading.getReader();
  const received: string[] = [];
  const drain = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      received.push(new TextDecoder().decode(value));
    }
  })();

  const big: PollerEvent = {
    type: "panel",
    panelId: "p1",
    mode: "replace",
    columns: ["v"],
    rows: Array.from({ length: 50 }, (_, v) => ({ v })),
  };
  for (let cycle = 1; cycle <= 4; cycle++) {
    for (const listener of [...listeners]) {
      listener({ ...big });
      listener({ type: "tick", at: cycle });
    }
    await settle();
  }
  assert.deepEqual(drops, ["stalled:slow"], "dropped once, after three cycles behind");
  // Capacity (#490): the drop and the bytes are counted.
  const scrape = await renderMetrics();
  assert.match(scrape, /holotable_sse_drops_total\{reason="slow"\} 1\b/);
  assert.match(scrape, /holotable_sse_bytes_total [1-9]/);
  assert.equal(
    listeners.length,
    1,
    "the stalled stream unsubscribed; the reader did not",
  );

  // The stalled stream ends with the drop frame, a reconnect hint before it.
  const text: string[] = [];
  for await (const chunk of stalled) text.push(new TextDecoder().decode(chunk));
  const last = text.at(-1) ?? "";
  assert.match(last, new RegExp(`^retry: \\d+\\nevent: ${DROP_EVENT}\\n`));
  assert.equal(text.filter((t) => t.includes('"type":"tick"')).length, 3);

  // The reader saw all four cycles.
  assert.equal(received.filter((t) => t.includes('"type":"tick"')).length, 4);
  void reader.cancel();
  await drain;
});

test("every stream response tells a proxy not to buffer or transform it", () => {
  assert.equal(STREAM_HEADERS["X-Accel-Buffering"], "no");
  assert.equal(STREAM_HEADERS["Cache-Control"], "no-cache, no-transform");
  assert.equal(STREAM_HEADERS["Content-Type"], "text/event-stream");
  const route = readFileSync("src/app/api/dashboards/[id]/stream/route.ts", "utf8");
  assert.match(route, /new Response\(stream, \{ headers: STREAM_HEADERS \}\)/);
});
