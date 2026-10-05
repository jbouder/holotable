import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Dashboard, Panel } from "@/lib/ir";
import {
  authorLabel,
  diffDashboards,
  fetchVersion,
  fetchVersionPage,
  restoreNote,
  restoreVersion,
  VERSION_PAGE_MAX,
  VERSION_PAGE_SIZE,
  VersionListQuery,
  VersionNumber,
} from "@/lib/dashboard-versions";

/**
 * Version history (#73): the structural diff, the query vocabulary, and the
 * browser helpers' distrust of what the routes send back.
 */

function panel(overrides: Partial<Panel> = {}): Panel {
  return {
    id: "rps",
    title: "Requests per second",
    viz: "line",
    query: { sourceId: "src-1", sql: "SELECT ts, n FROM rps", timeField: "ts" },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    ...overrides,
  };
}

function spec(panels: Panel[], patch: Partial<Dashboard> = {}): Dashboard {
  return {
    specVersion: 1,
    title: "Service health",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 15_000,
    panels,
    ...patch,
  };
}

const errors = panel({
  id: "errors",
  title: "Errors",
  viz: "stat",
  query: { sourceId: "src-1", sql: "SELECT count(*) AS value FROM errors" },
  layout: { x: 6, y: 0, w: 6, h: 4 },
});

/* -------------------------------------------------------------------------- */
/* diffDashboards                                                             */
/* -------------------------------------------------------------------------- */

test("a version compared with itself is identical", () => {
  const a = spec([panel(), errors]);
  const diff = diffDashboards(a, structuredClone(a));
  assert.equal(diff.identical, true);
  assert.equal(diff.panels.length, 0);
  assert.equal(diff.unchangedPanels, 2);
  assert.equal(diff.reordered, false);
});

test("panels are matched by id: added, removed and changed are told apart", () => {
  const latency = panel({ id: "latency", title: "p99 latency" });
  const before = spec([panel(), errors]);
  const after = spec([
    panel({ query: { sourceId: "src-1", sql: "SELECT ts, n\nFROM rps\nWHERE n > 0" } }),
    latency,
  ]);

  const diff = diffDashboards(before, after);
  assert.equal(diff.identical, false);
  assert.deepEqual(
    diff.panels.map((c) => [c.kind, c.kind === "changed" ? c.after.id : c.panel.id]),
    [
      ["changed", "rps"],
      ["added", "latency"],
      ["removed", "errors"],
    ],
  );
  const changed = diff.panels[0];
  assert.ok(changed.kind === "changed");
  // The same panel diff the NL edit review uses: SQL as lines, fields by name.
  assert.equal(changed.diff.sql.changed, true);
  assert.equal(changed.diff.sql.added, 3);
  assert.equal(changed.diff.sql.removed, 1);
  assert.deepEqual(
    changed.diff.fields.filter((f) => f.changed).map((f) => f.key),
    ["timeField"],
  );
  assert.equal(diff.unchangedPanels, 0);
});

test("a renamed panel is one change, not a removal and an addition", () => {
  const diff = diffDashboards(spec([panel()]), spec([panel({ title: "RPS" })]));
  assert.equal(diff.panels.length, 1);
  assert.equal(diff.panels[0].kind, "changed");
});

test("dashboard settings are compared as the reader sees them", () => {
  const diff = diffDashboards(
    spec([panel()]),
    spec([panel()], {
      title: "Service health (prod)",
      timeRange: { from: "now-6h", to: "now" },
      refreshIntervalMs: 60_000,
      variables: [
        { name: "env", type: "enum", values: ["prod", "staging"] },
        {
          name: "host",
          type: "query",
          query: { sourceId: "src", sql: "SELECT DISTINCT host FROM m" },
          multi: true,
        },
      ],
      annotations: { tags: ["deploy"] },
    }),
  );
  assert.deepEqual(
    diff.fields.map((f) => [f.key, f.before, f.after, f.changed]),
    [
      ["title", "Service health", "Service health (prod)", true],
      ["timeRange", "now-1h → now", "now-6h → now", true],
      ["refresh", "15s", "60s", true],
      ["variables", "none", ":env (2 values), :host (query, several)", true],
      ["annotations", "all", "tagged deploy", true],
    ],
  );
  assert.equal(diff.panels.length, 0);
  assert.equal(diff.identical, false);
});

test("a change of panel order alone is reported, and is not identical", () => {
  const diff = diffDashboards(spec([panel(), errors]), spec([errors, panel()]));
  assert.equal(diff.reordered, true);
  assert.equal(diff.panels.length, 0);
  assert.equal(diff.identical, false);
});

test("adding or removing a panel is not mistaken for a reorder", () => {
  const latency = panel({ id: "latency" });
  assert.equal(
    diffDashboards(spec([panel(), errors]), spec([latency, panel(), errors])).reordered,
    false,
  );
  assert.equal(diffDashboards(spec([panel(), errors]), spec([errors])).reordered, false);
});

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

test("a restore records the version it came from", () => {
  assert.equal(restoreNote(3), "restored from v3");
});

test("the author is 'you' or a short id, never a guessed name", () => {
  const sub = "3f2a9c1e-0b5d-4e2f-9a77-1c2d3e4f5a6b";
  assert.equal(authorLabel(sub, sub), "you");
  assert.equal(authorLabel(sub, "someone-else"), "user 3f2a9c1e");
  assert.equal(authorLabel("svc", "someone-else"), "user svc");
});

test("the list query is bounded, and a bad cursor is refused rather than ignored", () => {
  assert.deepEqual(VersionListQuery.parse({}), { limit: VERSION_PAGE_SIZE });
  assert.deepEqual(VersionListQuery.parse({ before: "12", limit: "5" }), {
    before: 12,
    limit: 5,
  });
  for (const bad of [
    { before: "0" },
    { before: "-1" },
    { before: "1.5" },
    { before: "abc" },
    { before: "99999999999" },
    { limit: "0" },
    { limit: String(VERSION_PAGE_MAX + 1) },
  ]) {
    assert.equal(VersionListQuery.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("a version in a path is a positive Postgres integer", () => {
  assert.equal(VersionNumber.parse("7"), 7);
  for (const bad of ["0", "-3", "2.5", "x", "2147483648", ""]) {
    assert.equal(VersionNumber.safeParse(bad).success, false, bad);
  }
});

/* -------------------------------------------------------------------------- */
/* API helpers                                                                */
/* -------------------------------------------------------------------------- */

interface Call {
  url: string;
  method: string;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(responses: Response[]): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
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

const row = {
  version: 4,
  createdBy: "sub-1",
  createdAt: "2026-10-04T10:00:00.000Z",
  note: "tightened the error query",
  panelCount: 2,
};

test("a page is read through its shape, and a malformed row is dropped", async () => {
  const calls = stubFetch([
    jsonResponse({
      versions: [row, { version: "5" }, { ...row, version: 3, note: 42 }],
      nextBefore: 3,
      current: 4,
    }),
  ]);
  const page = await fetchVersionPage("d 1", 5);
  assert.deepEqual(calls, [
    { url: "/api/dashboards/d%201/versions?before=5", method: "GET" },
  ]);
  assert.ok(page.ok);
  assert.deepEqual(
    page.versions.map((v) => [v.version, v.note]),
    [
      [4, "tightened the error query"],
      [3, null],
    ],
  );
  assert.equal(page.nextBefore, 3);
  assert.equal(page.current, 4);
});

test("a version whose spec is not a current IR spec is an error, not a render", async () => {
  stubFetch([jsonResponse({ version: { ...row, spec: { title: "no panels" } } })]);
  const bad = await fetchVersion("d1", 4);
  assert.equal(bad.ok, false);

  const good = spec([panel()]);
  const calls = stubFetch([jsonResponse({ version: { ...row, spec: good } })]);
  const ok = await fetchVersion("d1", 4);
  assert.equal(calls[0].url, "/api/dashboards/d1/versions/4");
  assert.ok(ok.ok);
  assert.deepEqual(ok.version.spec, good);
});

test("restore is a POST to the version, and surfaces the server's refusal", async () => {
  const calls = stubFetch([jsonResponse({ dashboard: { version: 9 } })]);
  const ok = await restoreVersion("d1", 4);
  assert.deepEqual(calls, [
    { url: "/api/dashboards/d1/versions/4/restore", method: "POST" },
  ]);
  assert.deepEqual(ok, { ok: true, version: 9 });

  stubFetch([
    jsonResponse(
      { error: 'panel "rps": column "secret" is not exposed' },
      { status: 400 },
    ),
  ]);
  const refused = await restoreVersion("d1", 4);
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error.error, /not exposed/);
});
