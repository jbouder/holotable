import { queryTimeField } from "@/lib/ir";
import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getPoller,
  type PanelExecutor,
  type PollerEvent,
  setPollerJitterForTests,
} from "@/lib/poller/registry";
import {
  decodeResumeToken,
  encodeResumeToken,
  MAX_RESUME_TOKEN_CHARS,
} from "@/lib/poller/resume";
import { encodeEventFrame, HEARTBEAT_FRAME } from "@/lib/sse";
import { mergePanelRows } from "@/lib/stream-merge";
import type { PanelData } from "@/components/charts/options";
import type { Dashboard } from "@/lib/ir";

// Cycles land on the interval exactly: no spread of the second one (#487).
setPollerJitterForTests(() => 0);

/**
 * Joining and resuming a shared dashboard stream (#43): each subscriber has
 * its own cursors, a joiner is caught up from the last cycle, and a reconnect
 * with its last event id is sent exactly what it missed.
 */

const INTERVAL = 60_000;

function spec(): Dashboard {
  return {
    specVersion: 1,
    title: "t",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: INTERVAL,
    panels: [
      {
        id: "series",
        title: "series",
        viz: "line",
        query: { sourceId: "s1", sql: "SELECT ts, v FROM m", timeField: "ts" },
        layout: { x: 0, y: 0, w: 6, h: 4 },
      },
      {
        id: "total",
        title: "total",
        viz: "stat",
        query: { sourceId: "s1", sql: "SELECT count(*) AS value FROM m" },
        layout: { x: 6, y: 0, w: 6, h: 4 },
      },
    ],
  };
}

const ts = (n: number) => `2026-10-04T10:00:${String(n).padStart(2, "0")}.000Z`;

/**
 * A source whose table grows by the rows pushed into `table`. The executor
 * returns the whole window every time, as the real one does.
 */
function growingSource() {
  const table: { ts: string; v: number }[] = [];
  const executor: PanelExecutor = async (panel) => [
    queryTimeField(panel.query)
      ? {
          type: "panel",
          panelId: panel.id,
          mode: "replace",
          columns: ["ts", "v"],
          rows: [...table],
        }
      : {
          type: "panel",
          panelId: panel.id,
          mode: "replace",
          columns: ["value"],
          rows: [{ value: table.length }],
        },
  ];
  const add = (...ns: number[]) => {
    for (const n of ns) table.push({ ts: ts(n), v: n });
  };
  /** The newest bucket is still filling: its value changes in place. */
  const bump = (v: number) => {
    const last = table.at(-1);
    if (last) last.v = v;
  };
  return { executor, add, bump };
}

interface Seen {
  events: PollerEvent[];
  lastId: string | undefined;
}

function viewer(): Seen & { listener: (e: PollerEvent, id?: string) => void } {
  const seen: Seen = { events: [], lastId: undefined };
  return Object.assign(seen, {
    listener(e: PollerEvent, id?: string) {
      seen.events.push(e);
      if (id) seen.lastId = id;
    },
  });
}

/** The series values a viewer holds, merged exactly as LiveDashboard merges them. */
function seriesRows(seen: Seen): number[] {
  let data: PanelData | undefined;
  for (const e of seen.events) {
    if (e.type === "panel" && e.panelId === "series") data = mergePanelRows(data, e, 720);
  }
  return (data?.rows ?? []).map((r) => Number(r.v));
}

function panelEvents(seen: Seen, panelId: string) {
  return seen.events.filter(
    (e): e is Extract<PollerEvent, { type: "panel" }> =>
      e.type === "panel" && e.panelId === panelId,
  );
}

/** Let the in-flight tick's promises settle. */
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

async function nextTick() {
  mock.timers.tick(INTERVAL);
  await settle();
}

afterEach(() => mock.timers.reset());

let n = 0;
const dashboardId = () => `dash-resume-${++n}`;

test("a second viewer joining a running dashboard gets the history, not just the next append", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { executor, add } = growingSource();
  add(1, 2, 3);
  const poller = getPoller(dashboardId(), 1, "ws", spec(), {}, executor);

  const a = viewer();
  const unsubA = poller.subscribe(a.listener);
  await settle();
  add(4);
  await nextTick();

  const b = viewer();
  const unsubB = poller.subscribe(b.listener);
  // Caught up at once, from memory, before any further tick.
  assert.deepEqual(seriesRows(b), [1, 2, 3, 4]);
  assert.equal(panelEvents(b, "series")[0].mode, "replace");
  assert.deepEqual(panelEvents(b, "total").at(-1)?.rows, [{ value: 4 }]);
  assert.ok(
    b.events.some((e) => e.type === "tick"),
    "the joiner is told how fresh the data is",
  );

  const aBefore = a.events.length;
  add(5);
  await nextTick();
  // Each viewer's own cursor: both get exactly row 5 as an append.
  assert.deepEqual(seriesRows(a), [1, 2, 3, 4, 5]);
  assert.deepEqual(seriesRows(b), [1, 2, 3, 4, 5]);
  assert.equal(panelEvents(b, "series").at(-1)?.mode, "append");
  // B's join sent A nothing.
  assert.equal(
    a.events.slice(aBefore).filter((e) => e.type === "panel" && e.panelId === "series")
      .length,
    1,
  );
  unsubA();
  unsubB();
});

test("a reconnect with its last event id misses nothing and repeats nothing", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { executor, add } = growingSource();
  add(1, 2);
  const id = dashboardId();
  const poller = getPoller(id, 1, "ws", spec(), {}, executor);

  // Someone else keeps the poller running throughout.
  const other = viewer();
  const unsubOther = poller.subscribe(other.listener);
  const a = viewer();
  let unsubA = poller.subscribe(a.listener);
  await settle();
  add(3);
  await nextTick();
  assert.deepEqual(seriesRows(a), [1, 2, 3]);

  // A's connection drops; rows arrive while it is gone.
  unsubA();
  const token = a.lastId;
  assert.ok(token);
  add(4, 5);
  await nextTick();
  add(6);
  await nextTick();

  const before = a.events.length;
  unsubA = poller.subscribe(a.listener, token);
  const resumed = a.events.slice(before);
  const series = resumed.filter((e) => e.type === "panel" && e.panelId === "series");
  assert.equal(series.length, 1);
  assert.equal(series[0].type === "panel" && series[0].mode, "append");
  assert.deepEqual(seriesRows(a), [1, 2, 3, 4, 5, 6], "no gap and no duplicate");

  add(7);
  await nextTick();
  assert.deepEqual(seriesRows(a), [1, 2, 3, 4, 5, 6, 7]);
  // The other viewer never noticed.
  assert.deepEqual(seriesRows(other), [1, 2, 3, 4, 5, 6, 7]);
  unsubA();
  unsubOther();
});

test("resuming into a poller that had stopped picks up from the cursor", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { executor, add } = growingSource();
  add(1, 2);
  const id = dashboardId();
  const a = viewer();
  let unsub = getPoller(id, 1, "ws", spec(), {}, executor).subscribe(a.listener);
  await settle();
  unsub(); // the only viewer: the poller stops
  add(3);

  unsub = getPoller(id, 1, "ws", spec(), {}, executor).subscribe(a.listener, a.lastId);
  await settle();
  assert.deepEqual(seriesRows(a), [1, 2, 3]);
  assert.equal(panelEvents(a, "series").at(-1)?.mode, "append");
  unsub();
});

test("a reconnect after the spec changed version, or with a bad id, gets a full snapshot", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { executor, add } = growingSource();
  add(1, 2);
  const id = dashboardId();
  const a = viewer();
  const unsub = getPoller(id, 1, "ws", spec(), {}, executor).subscribe(a.listener);
  await settle();
  unsub();
  const v1Token = a.lastId;

  for (const token of [
    v1Token,
    "!!not base64!!",
    "e30",
    "x".repeat(MAX_RESUME_TOKEN_CHARS + 1),
  ]) {
    const b = viewer();
    // Version 2 of the dashboard now.
    const off = getPoller(id, 2, "ws", spec(), {}, executor).subscribe(b.listener, token);
    await settle();
    assert.equal(
      panelEvents(b, "series")[0]?.mode,
      "replace",
      String(token).slice(0, 20),
    );
    assert.deepEqual(seriesRows(b), [1, 2]);
    off();
  }
});

test("the newest bucket updates in place while it fills, without duplicating", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { executor, add, bump } = growingSource();
  add(1, 2);
  const id = dashboardId();
  const a = viewer();
  let unsub = getPoller(id, 1, "ws", spec(), {}, executor).subscribe(a.listener);
  await settle();
  assert.deepEqual(seriesRows(a), [1, 2]);

  // The bucket at ts(2) keeps counting: 2 → 20 → 25.
  bump(20);
  await nextTick();
  assert.deepEqual(seriesRows(a), [1, 20]);
  bump(25);
  add(3);
  await nextTick();
  assert.deepEqual(seriesRows(a), [1, 25, 3]);

  // A resume overlaps at the cursor's bucket; that is an update too.
  unsub();
  bump(30);
  unsub = getPoller(id, 1, "ws", spec(), {}, executor).subscribe(a.listener, a.lastId);
  await settle();
  assert.deepEqual(seriesRows(a), [1, 25, 30]);
  unsub();
});

/* -------------------------------------------------------------------------- */
/* The token and the frames                                                   */
/* -------------------------------------------------------------------------- */

test("a resume token round-trips, and keeps only this spec's panels", () => {
  const token = encodeResumeToken(
    3,
    new Map([
      ["series", ts(5)],
      ["gone", ts(9)],
    ]),
  );
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(
    decodeResumeToken(token, 3, new Set(["series", "total"])),
    new Map([["series", ts(5)]]),
  );
  assert.equal(decodeResumeToken(token, 4, new Set(["series"])), null);
});

test("a token that is not one is no resume, never an error", () => {
  const ids = new Set(["series"]);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  for (const raw of [
    null,
    undefined,
    "",
    "has spaces",
    "a\nb",
    b64("just a string"),
    b64([1, 2]),
    b64({ v: 1 }),
    b64({ v: 1, c: [] }),
    b64({ v: "1", c: {} }),
  ]) {
    assert.equal(decodeResumeToken(raw, 1, ids), null, JSON.stringify(raw));
  }
  // Well-formed but with junk cursors: those are dropped, the rest kept.
  assert.deepEqual(
    decodeResumeToken(b64({ v: 1, c: { series: 42 } }), 1, ids),
    new Map(),
  );
  assert.deepEqual(
    decodeResumeToken(b64({ v: 1, c: { series: "x".repeat(65) } }), 1, ids),
    new Map(),
  );
});

test("a frame carries its id, and an id that could split the frame is dropped", () => {
  const text = (frame: Uint8Array) => new TextDecoder().decode(frame);
  const event = { a: 1 };
  assert.equal(text(encodeEventFrame(event, "abc")), 'id: abc\ndata: {"a":1}\n\n');
  assert.equal(text(encodeEventFrame(event)), 'data: {"a":1}\n\n');
  assert.equal(text(encodeEventFrame(event, "a\nevent: x")), 'data: {"a":1}\n\n');
  assert.match(HEARTBEAT_FRAME, /^:[^\n]*\n\n$/);
});

test("a panel with its own row limit is sent whole every cycle, never appended", async () => {
  // #499: appending to a "latest 50" table would grow it past 50 and put the
  // newest rows at the wrong end of a newest-first one.
  mock.timers.enable({ apis: ["setTimeout"] });
  const limited: Dashboard = {
    ...spec(),
    panels: [
      {
        id: "latest",
        title: "latest",
        viz: "table",
        query: { sourceId: "s1", sql: "SELECT ts, v FROM m", timeField: "ts" },
        options: { limit: 2 },
        layout: { x: 0, y: 0, w: 6, h: 4 },
      },
    ],
  };
  let cycle = 0;
  const executor: PanelExecutor = async (panel) => {
    cycle++;
    return [
      {
        type: "panel",
        panelId: panel.id,
        mode: "replace",
        columns: ["ts", "v"],
        rows: [
          { ts: ts(cycle + 1), v: cycle + 1 },
          { ts: ts(cycle), v: cycle },
        ],
      },
    ];
  };
  const frames: PollerEvent[] = [];
  const stop = getPoller(
    `limited-${Date.now()}`,
    1,
    "ws",
    limited,
    {},
    executor,
  ).subscribe((e) => {
    if (e.type === "panel") frames.push(e);
  });
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(INTERVAL);
  }
  await new Promise((r) => setImmediate(r));
  stop();
  assert.ok(frames.length >= 2);
  for (const f of frames) {
    assert.ok(f.type === "panel" && f.mode === "replace" && f.rows.length === 2);
  }
});

test("a newest-first panel's appends land on top, and the window keeps the top", async () => {
  // #531: without a row limit a newest-first table is appended to, and the
  // browser put each cycle's new rows at the bottom.
  mock.timers.enable({ apis: ["setTimeout"] });
  const log: Dashboard = {
    ...spec(),
    panels: [
      {
        id: "log",
        title: "log",
        viz: "table",
        query: {
          sourceId: "s1",
          sql: "SELECT ts, v FROM m ORDER BY ts DESC",
          timeField: "ts",
        },
        layout: { x: 0, y: 0, w: 6, h: 4 },
      },
    ],
  };
  let cycle = 0;
  const executor: PanelExecutor = async (panel) => {
    cycle++;
    const rows = Array.from({ length: cycle + 1 }, (_, i) => ({
      ts: ts(cycle - i),
      v: cycle - i,
    }));
    return [
      { type: "panel", panelId: panel.id, mode: "replace", columns: ["ts", "v"], rows },
    ];
  };
  const frames: Extract<PollerEvent, { type: "panel" }>[] = [];
  const stop = getPoller(
    `newest-first-${Date.now()}`,
    1,
    "ws",
    log,
    {},
    executor,
  ).subscribe((e) => {
    if (e.type === "panel") frames.push(e);
  });
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(INTERVAL);
  }
  await new Promise((r) => setImmediate(r));
  stop();
  assert.ok(frames.length >= 3);
  assert.ok(frames.every((f) => f.newestFirst === true));
  assert.equal(frames[1].mode, "append");

  let held: PanelData | undefined;
  for (const f of frames) held = mergePanelRows(held, f, 3);
  const newest = frames.length;
  assert.deepEqual(
    held?.rows.map((r) => r.v),
    [newest, newest - 1, newest - 2],
  );
  assert.equal(held?.truncated?.stage, "window");
});
