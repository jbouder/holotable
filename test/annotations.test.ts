import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { annotationMarks, lineChart, type PanelData } from "@/components/charts/options";
import { annotationWindow, dashboardAnnotations } from "@/lib/annotation-service";
import { type Annotation, AnnotationInput, readAnnotations } from "@/lib/annotations";
import { type AnnotationStore, makeAnnotationStore } from "@/lib/db/annotations";
import { Dashboard } from "@/lib/ir";
import { tokenHex } from "@/lib/panels/colors";
import { TimeRangeError } from "@/lib/time";
import { LOCAL_TIME_DISPLAY } from "@/lib/time-display";

/** Annotations (#68). */

const NOW = new Date("2026-10-04T12:00:00Z");
const MINUTE = 60_000;

function spec(
  extra: Record<string, unknown> = {},
  panelExtra: Record<string, unknown> = {},
) {
  return Dashboard.parse({
    specVersion: 1,
    title: "t",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 60_000,
    panels: [
      {
        id: "p",
        title: "p",
        viz: "line",
        query: { sourceId: "s", sql: "SELECT ts, v FROM m", timeField: "ts" },
        layout: { x: 0, y: 0, w: 6, h: 4 },
        ...panelExtra,
      },
    ],
    ...extra,
  });
}

function recordingStore(): AnnotationStore & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async list(input) {
      calls.push(input);
      return [];
    },
    async create() {
      throw new Error("unused");
    },
    async remove() {
      return false;
    },
  };
}

test("what may be written is checked", () => {
  const ok = {
    at: "2026-10-04T11:30:00Z",
    kind: "deploy",
    title: "api v2.4.1",
    tags: ["api", "prod"],
  };
  assert.ok(AnnotationInput.safeParse(ok).success);
  for (const bad of [
    { ...ok, kind: "outage" },
    { ...ok, title: "   " },
    { ...ok, title: "x".repeat(201) },
    { ...ok, at: "yesterday" },
    { ...ok, endedAt: "2026-10-04T11:00:00Z" },
    { ...ok, tags: ["has space"] },
    { ...ok, workspaceId: "other" },
  ]) {
    assert.equal(AnnotationInput.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("a dashboard reads only its own workspace, over the window it shows", async () => {
  const store = recordingStore();
  await dashboardAnnotations({
    dashboard: { workspaceId: "ws-a", spec: spec({ annotations: { tags: ["deploy"] } }) },
    shown: { from: "now-1h", to: "now" },
    store,
    now: NOW,
  });
  assert.deepEqual(store.calls, [
    {
      workspaceId: "ws-a",
      from: new Date(NOW.getTime() - 60 * MINUTE),
      to: NOW,
      tags: ["deploy"],
    },
  ]);

  const off = recordingStore();
  const none = await dashboardAnnotations({
    dashboard: { workspaceId: "ws-a", spec: spec({ annotations: { show: false } }) },
    shown: { from: "now-1h", to: "now" },
    store: off,
    now: NOW,
  });
  assert.deepEqual(none, []);
  assert.equal(off.calls.length, 0, "a dashboard that turns them off reads nothing");
});

test("a panel with its own window widens what is read (#114)", () => {
  const window = annotationWindow(
    spec({}, { timeRange: { from: "now-24h", to: "now" } }),
    { from: "now-1h", to: "now" },
    NOW,
  );
  assert.equal(window.from.getTime(), NOW.getTime() - 24 * 60 * MINUTE);
  assert.throws(
    () => annotationWindow(spec(), { from: "now", to: "now-1h" }, NOW),
    TimeRangeError,
  );
});

test("what the API returns is read defensively", () => {
  assert.deepEqual(
    readAnnotations({
      annotations: [
        { id: "a", at: 1, kind: "deploy", title: "ok", tags: ["x", 2], source: "ci" },
        { id: "b", at: "1", kind: "deploy", title: "bad at" },
        { id: "c", at: 1, kind: "<script>", title: "bad kind" },
        null,
      ],
    }),
    [
      {
        id: "a",
        at: 1,
        endedAt: undefined,
        kind: "deploy",
        title: "ok",
        description: undefined,
        tags: ["x"],
        source: "ci",
        createdBy: "",
      },
    ],
  );
  assert.deepEqual(readAnnotations({ annotations: "nope" }), []);
});

const at = (minute: number) => new Date(NOW.getTime() + minute * MINUTE).toISOString();
const rows: PanelData = {
  columns: ["ts", "v"],
  rows: [0, 1, 2, 3, 4].map((m) => ({ ts: at(m), v: m })),
};
const ann = (extra: Partial<Annotation>): Annotation => ({
  id: "x",
  at: NOW.getTime(),
  kind: "deploy",
  title: "deploy",
  tags: [],
  source: "manual",
  createdBy: "u",
  ...extra,
});

test("a point is placed at the first row at or after it, a range is clipped, and the rest is left off", () => {
  const marks = annotationMarks(
    [
      ann({ at: NOW.getTime() + 1.5 * MINUTE, title: "deploy" }),
      ann({ at: NOW.getTime() - 10 * MINUTE, title: "before the chart" }),
      ann({ at: NOW.getTime() + 10 * MINUTE, title: "after the chart" }),
      ann({
        kind: "incident",
        title: "incident",
        at: NOW.getTime() - 5 * MINUTE,
        endedAt: NOW.getTime() + 2 * MINUTE,
      }),
      ann({
        kind: "note",
        title: "still open",
        at: NOW.getTime() + 3 * MINUTE,
        endedAt: NOW.getTime() + 30 * MINUTE,
      }),
    ],
    rows.rows.map((r) => r.ts),
    LOCAL_TIME_DISPLAY,
  );
  const lines = marks.markLine.data as {
    name: string;
    xAxis: number;
    lineStyle: { color: string };
  }[];
  assert.deepEqual(
    lines.map((l) => [l.name, l.xAxis]),
    [["deploy", 2]],
  );
  assert.equal(lines[0].lineStyle.color, tokenHex("info"));
  const areas = marks.markArea.data as [
    { name: string; xAxis: number },
    { xAxis: number },
  ][];
  assert.deepEqual(
    areas.map(([a, b]) => [a.name, a.xAxis, b.xAxis]),
    [
      ["incident", 0, 2],
      ["still open", 3, 4],
    ],
  );
});

test("a range between two rows still covers its span", () => {
  const marks = annotationMarks(
    [
      ann({
        kind: "incident",
        title: "short",
        at: NOW.getTime() + 1.2 * MINUTE,
        endedAt: NOW.getTime() + 1.6 * MINUTE,
      }),
    ],
    rows.rows.map((r) => r.ts),
    LOCAL_TIME_DISPLAY,
  );
  const [[start, end]] = marks.markArea.data as [{ xAxis: number }, { xAxis: number }][];
  assert.deepEqual([start.xAxis, end.xAxis], [1, 2]);
});

test("marks ride on the chart without changing it when there are none", () => {
  const panel = spec().panels[0];
  const ctx = { display: LOCAL_TIME_DISPLAY };
  const plain = lineChart(panel, rows, ctx) as { series: Record<string, unknown>[] };
  assert.equal("markLine" in plain.series[0], false, "no annotations, no marks");
  const empty = lineChart(panel, rows, { ...ctx, annotations: [] }) as {
    series: Record<string, unknown>[];
  };
  // An empty list still sets the marks, so the merge clears ones that left.
  assert.deepEqual((empty.series[0].markLine as { data: unknown[] }).data, []);
  assert.deepEqual((empty.series[0].markArea as { data: unknown[] }).data, []);
  const drawn = lineChart(panel, rows, { ...ctx, annotations: [ann({})] }) as {
    series: Record<string, unknown>[];
  };
  assert.equal((drawn.series[0].markLine as { data: unknown[] }).data.length, 1);
});

test("writing needs an editor and reading a viewer, each in the workspace it touches", () => {
  const route = (path: string) =>
    readFileSync(new URL(`../src/app/api/${path}/route.ts`, import.meta.url), "utf8");
  assert.match(
    route("dashboards/[id]/annotations"),
    /"dashboard:view",\s+\{ workspaceId: dashboard\.workspaceId \}/,
  );
  for (const path of [
    "workspaces/[id]/annotations",
    "workspaces/[id]/annotations/[annotationId]",
  ]) {
    assert.match(
      route(path),
      /"dashboard:update",\s+\{ workspaceId: workspaceId\.data \}/,
      path,
    );
  }
});

/* Against a real server: a workspace never reads or deletes another's rows. */

const dbUrl = process.env.MIGRATE_TEST_DATABASE_URL;

test("annotations are kept to their workspace", {
  skip: dbUrl ? false : "run with npm run test:integration (needs Docker)",
}, async () => {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  const schema = `annotations_test_${process.pid}`;
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    const migration = readFileSync(
      new URL("../migrations/013_annotations.sql", import.meta.url),
      "utf8",
    );
    await client.query(migration.split(/^-- rollback:/m)[0]);
    const store = makeAnnotationStore(async (text, params) => {
      const res = await client.query(text, params as unknown[]);
      return res.rows;
    });
    const input = (title: string) => ({
      at: at(1),
      kind: "deploy" as const,
      title,
      tags: ["api"],
    });
    const mine = await store.create({
      workspaceId: "a",
      createdBy: "u",
      annotation: input("mine"),
    });
    const theirs = await store.create({
      workspaceId: "b",
      createdBy: "u",
      annotation: input("theirs"),
    });
    const window = { from: new Date(at(0)), to: new Date(at(5)) };
    assert.deepEqual(
      (await store.list({ workspaceId: "a", ...window })).map((x) => x.title),
      ["mine"],
    );
    assert.deepEqual(
      (await store.list({ workspaceId: "a", ...window, tags: ["db"] })).map(
        (x) => x.title,
      ),
      [],
    );
    assert.equal(await store.remove({ workspaceId: "a", id: theirs.id }), false);
    assert.equal((await store.list({ workspaceId: "b", ...window })).length, 1);
    assert.equal(await store.remove({ workspaceId: "a", id: mine.id }), true);
    await assert.rejects(
      client.query(
        "INSERT INTO annotations (workspace_id, at, ended_at, kind, title, created_by) VALUES ('a', now(), now() - interval '1 hour', 'note', 'x', 'u')",
      ),
      /check/i,
    );
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});
