import { test } from "node:test";
import assert from "node:assert/strict";
import type { Dashboard, Panel } from "@/lib/ir";
import {
  DashboardExportFile,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  buildDashboardExport,
  exportFilename,
  referencedSourceIds,
  remapSourceIds,
  unresolvedSourceIds,
} from "@/lib/dashboard-export";

function panel(overrides: Partial<Panel> = {}): Panel {
  return {
    id: "requests",
    title: "Requests",
    viz: "line",
    query: {
      sourceId: "src-a",
      sql: "SELECT ts, value FROM metrics",
      timeField: "ts",
    },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    ...overrides,
  };
}

function spec(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    title: "Service health",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 30_000,
    panels: [panel()],
    ...overrides,
  };
}

const AT = new Date("2026-09-22T12:00:00.000Z");

/* -------------------------------------------------------------------------- */
/* The envelope is an allowlist                                               */
/* -------------------------------------------------------------------------- */

test("the export carries exactly the envelope fields, and no others", () => {
  const file = buildDashboardExport({ spec: spec(), version: 3 }, AT);

  assert.deepEqual(Object.keys(file).sort(), [
    "exportedAt",
    "format",
    "formatVersion",
    "manifest",
    "spec",
  ]);
  assert.deepEqual(Object.keys(file.manifest).sort(), [
    "dashboardVersion",
    "panelCount",
    "sourceIds",
    "title",
  ]);
  assert.equal(file.format, EXPORT_FORMAT);
  assert.equal(file.formatVersion, EXPORT_FORMAT_VERSION);
  assert.equal(file.exportedAt, "2026-09-22T12:00:00.000Z");
  assert.deepEqual(file.manifest, {
    title: "Service health",
    panelCount: 1,
    dashboardVersion: 3,
    sourceIds: ["src-a"],
  });
});

test("the export carries no credential, connection detail or secret ref", () => {
  // The builder takes only a spec and a version, so a DashboardRecord's
  // workspace and author and the registry's host, port and `secret_ref` are
  // not even in scope. Hand it all of them anyway — a widened input shape is
  // exactly how they would start travelling — and assert none of it appears.
  const leaky = {
    spec: spec({ panels: [panel(), panel({ id: "p2" })] }),
    version: 1,
    workspaceId: "ws-secret",
    createdBy: "sub-secret",
    secretRef: "PGPASS_SECRET",
    config: {
      host: "db.internal.secret",
      port: 5432,
      database: "prod_secret",
      password: "hunter2-secret",
    },
  };
  const file = buildDashboardExport(leaky, AT);

  const serialized = JSON.stringify(file);
  for (const planted of [
    "ws-secret",
    "sub-secret",
    "PGPASS_SECRET",
    "db.internal.secret",
    "5432",
    "prod_secret",
    "hunter2-secret",
  ]) {
    assert.ok(
      !serialized.includes(planted),
      `export payload must not carry "${planted}": ${serialized}`,
    );
  }

  // And no key by those names, whatever the value would have been.
  const keys = new Set<string>();
  collectKeys(file, keys);
  for (const key of [
    "password",
    "secret_ref",
    "secretRef",
    "host",
    "port",
    "ssl",
    "database",
    "config",
    "connection",
    "credential",
    "token",
    "workspaceId",
    "workspace_id",
    "createdBy",
    "created_by",
  ]) {
    assert.ok(!keys.has(key), `export payload must not carry a "${key}" key`);
  }
});

function collectKeys(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    into.add(key);
    collectKeys(child, into);
  }
}

test("the spec is copied verbatim, down to the SQL text", () => {
  const sql = "SELECT\n  ts,\n  avg(value) AS v\nFROM metrics\nGROUP BY 1";
  const original = spec({ panels: [panel({ query: { sourceId: "src-a", sql } })] });
  const file = buildDashboardExport({ spec: original, version: 1 }, AT);
  assert.deepEqual(file.spec, original);
  assert.equal(file.spec.panels[0].query.sql, sql);
});

/* -------------------------------------------------------------------------- */
/* Round trip                                                                 */
/* -------------------------------------------------------------------------- */

test("an export parses back as a valid file with an identical spec", () => {
  const original = spec({
    panels: [
      panel(),
      panel({ id: "errors", title: "Errors", viz: "stat", format: "percent" }),
    ],
  });
  const file = buildDashboardExport({ spec: original, version: 7 }, AT);

  // Through JSON, the way a real round trip goes.
  const parsed = DashboardExportFile.parse(JSON.parse(JSON.stringify(file)));
  assert.deepEqual(parsed.spec, original);
});

test("a hand-written file needs only the format tag and a spec", () => {
  const parsed = DashboardExportFile.parse({
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    spec: spec(),
  });
  assert.equal(parsed.manifest, undefined);
  assert.deepEqual(parsed.spec, spec());
});

/* -------------------------------------------------------------------------- */
/* A hostile or malformed file is refused                                     */
/* -------------------------------------------------------------------------- */

test("refuses a file that is not a dashboard export", () => {
  for (const body of [
    null,
    "a string",
    42,
    {},
    { spec: spec() },
    { format: "something.else", formatVersion: 1, spec: spec() },
    { format: EXPORT_FORMAT, formatVersion: 2, spec: spec() },
    { format: EXPORT_FORMAT, formatVersion: EXPORT_FORMAT_VERSION },
  ]) {
    assert.equal(
      DashboardExportFile.safeParse(body).success,
      false,
      `should refuse ${JSON.stringify(body)}`,
    );
  }
});

test("refuses unknown fields at both levels rather than ignoring them", () => {
  const good = buildDashboardExport({ spec: spec(), version: 1 }, AT);

  assert.equal(
    DashboardExportFile.safeParse({ ...good, workspaceId: "ws-other" }).success,
    false,
  );
  assert.equal(
    DashboardExportFile.safeParse({
      ...good,
      manifest: { ...good.manifest, secretRef: "PGPASS" },
    }).success,
    false,
  );
  assert.equal(
    DashboardExportFile.safeParse({
      ...good,
      spec: {
        ...good.spec,
        panels: [
          {
            ...good.spec.panels[0],
            query: { sourceId: "s", sql: "SELECT 1", host: "db" },
          },
        ],
      },
    }).success,
    false,
  );
});

test("refuses a spec that would not be a valid dashboard", () => {
  const cases: unknown[] = [
    spec({ panels: [] }),
    spec({ panels: [panel(), panel()] }), // duplicate panel id
    spec({ refreshIntervalMs: 10 }),
    spec({ timeRange: { from: "yesterday", to: "now" } as never }),
    spec({ panels: [panel({ query: { sourceId: "s", sql: "x".repeat(8_001) } })] }),
  ];
  for (const bad of cases) {
    assert.equal(
      DashboardExportFile.safeParse({
        format: EXPORT_FORMAT,
        formatVersion: EXPORT_FORMAT_VERSION,
        spec: bad,
      }).success,
      false,
      `should refuse ${JSON.stringify(bad).slice(0, 80)}`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Source resolution                                                          */
/* -------------------------------------------------------------------------- */

test("referenced ids are distinct and in spec order", () => {
  const s = spec({
    panels: [
      panel({ id: "a", query: { sourceId: "src-b", sql: "SELECT 1" } }),
      panel({ id: "b", query: { sourceId: "src-a", sql: "SELECT 1" } }),
      panel({ id: "c", query: { sourceId: "src-b", sql: "SELECT 1" } }),
    ],
  });
  assert.deepEqual(referencedSourceIds(s), ["src-b", "src-a"]);
});

test("unresolved ids name every source the target workspace lacks", () => {
  const s = spec({
    panels: [
      panel({ id: "a", query: { sourceId: "src-a", sql: "SELECT 1" } }),
      panel({ id: "b", query: { sourceId: "src-b", sql: "SELECT 1" } }),
      panel({ id: "c", query: { sourceId: "src-c", sql: "SELECT 1" } }),
    ],
  });
  assert.deepEqual(unresolvedSourceIds(s, ["src-b"]), ["src-a", "src-c"]);
  assert.deepEqual(unresolvedSourceIds(s, ["src-a", "src-b", "src-c"]), []);
  assert.deepEqual(unresolvedSourceIds(s, []), ["src-a", "src-b", "src-c"]);
});

test("remapping moves only the source reference, and only where named", () => {
  const original = spec({
    panels: [
      panel({ id: "a", query: { sourceId: "src-a", sql: "SELECT 1", timeField: "ts" } }),
      panel({ id: "b", query: { sourceId: "src-b", sql: "SELECT 2" } }),
    ],
  });
  const moved = remapSourceIds(original, { "src-a": "local-db" });

  assert.deepEqual(referencedSourceIds(moved), ["local-db", "src-b"]);
  assert.deepEqual(moved.panels[0], {
    ...original.panels[0],
    query: { sourceId: "local-db", sql: "SELECT 1", timeField: "ts" },
  });
  assert.deepEqual(moved.panels[1], original.panels[1]);
  // Pure: the input is untouched.
  assert.equal(original.panels[0].query.sourceId, "src-a");
});

test("an empty mapping is the identity, so a same-registry import round-trips", () => {
  const original = spec({ panels: [panel(), panel({ id: "p2" })] });
  assert.deepEqual(remapSourceIds(original, {}), original);
});

/* -------------------------------------------------------------------------- */
/* Filename                                                                   */
/* -------------------------------------------------------------------------- */

test("the filename is a slug of the title", () => {
  assert.equal(exportFilename("Service health"), "holotable-service-health.json");
  assert.equal(exportFilename("API  —  p99 latency"), "holotable-api-p99-latency.json");
});

test("the filename cannot inject a Content-Disposition header", () => {
  for (const title of [
    'evil"; filename="passwd',
    "line\r\nX-Injected: yes",
    "../../etc/passwd",
    "…",
    "日本語",
  ]) {
    const name = exportFilename(title);
    assert.match(name, /^holotable-[a-z0-9-]*\.json$/, `unsafe filename for ${title}`);
  }
  assert.equal(exportFilename("…"), "holotable-dashboard.json");
  assert.equal(exportFilename("---"), "holotable-dashboard.json");
});

test("a long title is truncated without a trailing dash", () => {
  const name = exportFilename("a ".repeat(80));
  assert.match(name, /^holotable-[a-z0-9-]*[a-z0-9]\.json$/);
  assert.ok(name.length <= "holotable-".length + 48 + ".json".length);
});
