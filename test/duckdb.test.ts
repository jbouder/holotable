import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { config } from "@/lib/config";
import { DUCKDB_UNAVAILABLE, setDuckDbLoaderForTests } from "@/lib/duckdb/binding";
import { openEngine } from "@/lib/duckdb/client";
import { listSourcePaths, resolveSourcePath, SOURCES_DIR_UNSET } from "@/lib/duckdb/path";
import { parseGroups } from "@/lib/auth/claims";
import { can } from "@/lib/auth/authorize";
import { Panel, PanelQuery } from "@/lib/ir";
import { createLogger, setLogger } from "@/lib/log";
import { makePanelExecutor } from "@/lib/poller/registry";
import { needsSecretRef, type SourceRecord, SourceDraft } from "@/lib/registry";
import { sourceListing } from "@/lib/source-listing";
import { QueryExecutionError } from "@/lib/sources/execution";
import { DuckDbConfig } from "@/lib/sources/kinds/duckdb";
import {
  duckdbDiscovery,
  duckdbPathMenu,
  serverKind,
  sourceKindAvailability,
} from "@/lib/sources/server/registry";
import type { SourcePlan } from "@/lib/sources/server/types";

/**
 * The DuckDB kind end to end (#572), against the real binding: a directory
 * of Parquet and CSV files and a `.duckdb` file each register, test, refresh
 * and answer a panel; the locked engine refuses the escapes the guard is
 * meant to stop first; and no path reaches a listing, a result or a log line.
 * The fixture files are written by the binding itself under a temporary
 * root, so nothing binary is committed.
 */

const writable = config as {
  duckdbSourcesDir: string;
  queryTimeoutSeconds: number;
  maxResultBytes: number;
};
const saved = {
  duckdbSourcesDir: writable.duckdbSourcesDir,
  queryTimeoutSeconds: writable.queryTimeoutSeconds,
  maxResultBytes: writable.maxResultBytes,
};

let base = "";
let root = "";
let outsideFile = "";
const lines: string[] = [];

before(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "holotable-duckdb-")));
  root = join(base, "root");
  mkdirSync(join(root, "lake"), { recursive: true });
  mkdirSync(join(root, "other"), { recursive: true });
  outsideFile = join(base, "outside.csv");
  writeFileSync(outsideFile, "secret\nhunter2\n");
  writeFileSync(join(root, "other", "neighbor.csv"), "n\n1\n");

  const writer = await DuckDBInstance.create(":memory:");
  const c = await writer.connect();
  const lake = join(root, "lake");
  // One row a minute from 2026-01-01T00:00Z, as a zoneless TIMESTAMP and as
  // a TIMESTAMPTZ (which Parquet stores as UTC with a zone flag).
  await c.run(
    `COPY (SELECT TIMESTAMP '2026-01-01 00:00:00' + INTERVAL (i) MINUTE AS ts,
                  TIMESTAMPTZ '2026-01-01 00:00:00+00' + INTERVAL (i) MINUTE AS tz,
                  'h' || (i % 3) AS host, i::DOUBLE AS v
             FROM range(60) t(i)) TO '${lake}/metrics.parquet' (FORMAT parquet)`,
  );
  await c.run(
    `COPY (SELECT 'h' || i AS host, 'rack' || i AS rack FROM range(3) t(i))
       TO '${lake}/hosts.csv' (HEADER)`,
  );
  await c.run(`ATTACH '${root}/app.duckdb' AS app`);
  await c.run(
    `CREATE TABLE app.requests AS
       SELECT TIMESTAMP '2026-01-01 00:00:00' + INTERVAL (i) SECOND AS ts,
              200 + (i % 2) * 300 AS status, 'secret-' || i AS token
         FROM range(100) t(i)`,
  );
  await c.run("DETACH app");
  c.closeSync();
  writer.closeSync();

  writable.duckdbSourcesDir = root;
  setLogger(
    createLogger({ level: "debug", format: "json", sink: (line) => lines.push(line) }),
  );
});

after(async () => {
  for (const id of ["lake", "app", "busy"]) await serverKind("duckdb").dispose(id);
  Object.assign(writable, saved);
  setLogger(createLogger());
  setDuckDbLoaderForTests(null);
});

function record(id: string, cfg: unknown): SourceRecord {
  return {
    id,
    workspaceId: "ws",
    name: id,
    kind: "duckdb",
    config: DuckDbConfig.parse(cfg),
    secretRef: null,
    catalogRefreshedAt: null,
    catalogMissingTables: [],
    createdBy: "u",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    tombstonedAt: null,
  };
}

const lakeSource = () =>
  record("lake", {
    kind: "duckdb",
    path: "lake",
    tables: [
      {
        name: "metrics",
        timeField: "ts",
        columns: [
          { name: "ts", type: "TIMESTAMP" },
          { name: "host", type: "VARCHAR" },
        ],
      },
      { name: "hosts", columns: [{ name: "host", type: "VARCHAR" }] },
      { name: "gone", columns: [{ name: "x", type: "BIGINT" }] },
    ],
  });

const appSource = () =>
  record("app", {
    kind: "duckdb",
    path: "app.duckdb",
    tables: [
      {
        name: "requests",
        timeField: "ts",
        columns: [
          { name: "ts", type: "TIMESTAMP" },
          { name: "status", type: "INTEGER" },
          { name: "token", type: "VARCHAR", exposed: false },
        ],
      },
    ],
  });

const JAN1 = Date.UTC(2026, 0, 1);
const minutes = (n: number) => new Date(JAN1 + n * 60_000);

async function run(source: SourceRecord, sql: string, timeField?: string, to = 10) {
  const kind = serverKind(source);
  const query = PanelQuery.parse({ sourceId: source.id, sql, timeField });
  const check = await kind.check(source, query);
  assert.ok(check.ok, check.error);
  const plan = kind.plan(source, query, {
    from: minutes(5),
    to: minutes(to),
    rowFilter: null,
  });
  return kind.execute(source, plan);
}

/** Nothing the server sends or logs says where the files are. */
function assertNoPath(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  assert.ok(!text.includes(base), `a path leaked: ${text.slice(0, 300)}`);
}

test("a DuckDB source names no secret_ref, and its listing names no path", () => {
  const source = lakeSource();
  assert.equal(needsSecretRef(source.config), false);
  const draft = (secretRef?: string) =>
    SourceDraft.safeParse({ id: "lake", name: "Lake", config: source.config, secretRef });
  assert.ok(draft().success);
  assert.equal(draft("TS_METRICS").success, false);

  const listing = sourceListing({ ...source, catalogFacts: { duckdb: "1.5.6" } });
  assert.deepEqual(Object.keys(listing).sort(), [
    "engine",
    "id",
    "kind",
    "layout",
    "name",
    "tableCount",
    "tombstonedAt",
    "workspaceId",
  ]);
  assert.equal(listing.kind, "duckdb");
  assert.ok("layout" in listing && listing.layout === "directory");
  assert.ok("engine" in listing && listing.engine === "DuckDB 1.5.6");
  const app = sourceListing(appSource());
  assert.ok("layout" in app && app.layout === "database");
});

test("checkConfig refuses every DuckDB config while DUCKDB_SOURCES_DIR is unset", async () => {
  const kind = serverKind("duckdb");
  assert.equal(await kind.checkConfig(lakeSource().config), null);
  writable.duckdbSourcesDir = "";
  try {
    const problem = await kind.checkConfig(lakeSource().config);
    assert.match(problem ?? "", /DUCKDB_SOURCES_DIR/);
    const result = await kind.test(lakeSource());
    assert.equal(result.ok, false);
    assert.match(result.message, /DUCKDB_SOURCES_DIR/);
  } finally {
    writable.duckdbSourcesDir = root;
  }
  // A path that resolves out of the root is refused on save.
  const escaping = { ...lakeSource().config, path: "missing" };
  assert.match((await kind.checkConfig(escaping)) ?? "", /does not exist/);
});

test("the locked engine refuses the escapes itself: another file, ATTACH, INSTALL, SET", async () => {
  // The guard refuses every one of these first; this is the engine with the
  // guard out of the way, the second belt.
  const resolved = await resolveSourcePath("lake", root);
  const { instance } = await openEngine(await import("@duckdb/node-api"), resolved);
  const c = await instance.connect();
  try {
    const refusals: [string, RegExp][] = [
      [`SELECT * FROM read_csv('${outsideFile}')`, /Permission Error/],
      ["SELECT * FROM read_csv('/etc/hosts')", /Permission Error/],
      [`SELECT * FROM read_csv('${root}/other/neighbor.csv')`, /Permission Error/],
      [`ATTACH '${root}/app.duckdb' AS stolen`, /Permission Error/],
      ["INSTALL httpfs", /Permission Error/],
      ["LOAD httpfs", /disabled/],
      ["SET memory_limit='64GB'", /locked/],
      ["SET enable_external_access=true", /locked/],
      ["SET allowed_directories=['/']", /locked|disabled/],
      // No file can be created, even beside the source's own.
      [`COPY (SELECT 1) TO '${root}/lake/written.csv'`, /Permission Error/],
      [`COPY (SELECT 1) TO '${root}/lake/metrics.parquet'`, /Permission Error/],
    ];
    for (const [sql, refusal] of refusals) {
      await assert.rejects(c.run(sql), refusal, sql);
    }
    // While its own files still read, through the views made before the lock.
    const reader = await c.runAndReadAll("SELECT count(*) AS n FROM metrics");
    assert.equal(Number(reader.getRowObjectsJS()[0].n), 60);
  } finally {
    c.closeSync();
    instance.closeSync();
  }
});

test("a directory of files answers a panel, windowed in UTC against TIMESTAMP and TIMESTAMPTZ", async () => {
  const source = lakeSource();
  const naive = await run(source, "SELECT ts, host FROM metrics", "ts");
  // [00:05, 00:10): five rows, in the statement's order, as ISO instants.
  assert.deepEqual(naive.columns, ["ts", "host"]);
  assert.equal(naive.rows.length, 5);
  assert.equal(naive.rows[0].ts, "2026-01-01T00:05:00.000Z");
  assert.equal(naive.truncated, undefined);
  // A TIMESTAMPTZ column is compared as the instant it is, whatever zone the
  // host is in: the engine's TimeZone is UTC, set before the lock.
  const zoned = await run(source, "SELECT tz, host FROM metrics", "tz");
  assert.equal(zoned.rows.length, 5);
  assert.equal(zoned.rows[0].tz, "2026-01-01T00:05:00.000Z");
  // A CSV file is a table too, and time_bucket exists.
  const joined = await run(
    source,
    "SELECT time_bucket(INTERVAL '5 minutes', m.ts) AS t, count(*) AS n FROM metrics m JOIN hosts h ON h.host = m.host GROUP BY 1 ORDER BY 1",
    "t",
    30,
  );
  assert.deepEqual(
    joined.rows.map((r) => [r.t, r.n]),
    [
      ["2026-01-01T00:05:00.000Z", 5],
      ["2026-01-01T00:10:00.000Z", 5],
      ["2026-01-01T00:15:00.000Z", 5],
      ["2026-01-01T00:20:00.000Z", 5],
      ["2026-01-01T00:25:00.000Z", 5],
    ],
  );
});

test("the guard runs first: a table function, an unlisted file, a hidden column", async () => {
  const kind = serverKind("duckdb");
  const check = async (source: SourceRecord, sql: string) =>
    kind.check(source, PanelQuery.parse({ sourceId: source.id, sql }));
  assert.equal(
    (await check(lakeSource(), "SELECT * FROM read_csv('/etc/hosts')")).ok,
    false,
  );
  assert.equal((await check(lakeSource(), "SELECT * FROM neighbor")).ok, false);
  assert.equal((await check(appSource(), "SELECT token FROM requests")).ok, false);
  assert.equal((await check(appSource(), "SELECT status FROM main.requests")).ok, true);
  // A PromQL query is refused as the wrong language.
  const promql = PanelQuery.parse({ sourceId: "app", promql: "up" });
  assert.match((await kind.check(appSource(), promql)).error ?? "", /answers SQL/);
});

test("a .duckdb file answers a panel, and the row cap is said", async () => {
  const source = appSource();
  const result = await run(source, "SELECT ts, status FROM requests", "ts");
  // Every row is in the first 100 seconds, outside [00:05, 00:10).
  assert.equal(result.rows.length, 0);
  const kind = serverKind(source);
  const query = PanelQuery.parse({
    sourceId: "app",
    sql: "SELECT ts, status FROM requests ORDER BY ts",
    timeField: "ts",
  });
  const plan = kind.plan(source, query, {
    from: new Date(JAN1),
    to: minutes(10),
    rowFilter: null,
    maxRows: 10,
  });
  const capped = await kind.execute(source, plan);
  // The newest ten, in the statement's order, and the cut travels.
  assert.equal(capped.rows.length, 10);
  assert.equal(capped.rows[9].ts, "2026-01-01T00:01:39.000Z");
  assert.deepEqual(capped.truncated, { stage: "rows", kept: 10, total: 100 });
  // Without a time field, one past the cap is how the cut is seen.
  const untimed = kind.plan(
    source,
    PanelQuery.parse({ sourceId: "app", sql: "SELECT status FROM requests" }),
    { from: new Date(JAN1), to: minutes(10), rowFilter: null, maxRows: 7 },
  );
  const cut = await kind.execute(source, untimed);
  assert.equal(cut.rows.length, 7);
  assert.deepEqual(cut.truncated, { stage: "rows", kept: 7 });
});

test("the byte cap and the timeout each stop a run with a message, never a path", async () => {
  const source = lakeSource();
  writable.maxResultBytes = 200;
  try {
    await assert.rejects(run(source, "SELECT ts, host FROM metrics", "ts", 60), (err) => {
      assert.ok(err instanceof QueryExecutionError);
      assert.match(err.message, /MAX_RESULT_BYTES/);
      return true;
    });
  } finally {
    writable.maxResultBytes = saved.maxResultBytes;
  }
  writable.queryTimeoutSeconds = 1;
  try {
    // Straight to the executor: a statement the guard would refuse, slow on
    // purpose, so the only thing that can stop it is the interrupt.
    const plan: SourcePlan = {
      language: "sql",
      plan: {
        sql: "SELECT count(*) AS n FROM range(1000000000000) a",
        params: [],
        ranked: false,
      },
    };
    const started = Date.now();
    await assert.rejects(serverKind(source).execute(source, plan), (err) => {
      assert.ok(err instanceof QueryExecutionError);
      assert.match(err.message, /QUERY_TIMEOUT_SECONDS/);
      return true;
    });
    assert.ok(Date.now() - started < 10_000, "the interrupt stopped it");
  } finally {
    writable.queryTimeoutSeconds = saved.queryTimeoutSeconds;
  }
});

test("an engine error is scrubbed of paths", async () => {
  const source = lakeSource();
  // The allowlist names a table whose file is gone; DuckDB's own message
  // would name the directory it looked in.
  const kind = serverKind(source);
  const query = PanelQuery.parse({ sourceId: "lake", sql: "SELECT x FROM gone" });
  const plan = kind.plan(source, query, {
    from: minutes(0),
    to: minutes(1),
    rowFilter: null,
  });
  await assert.rejects(kind.execute(source, plan), (err) => {
    assert.ok(err instanceof QueryExecutionError);
    assertNoPath(err.message);
    return true;
  });
});

test("Test opens, checks each table and reads the lock; refresh reports and never adds", async () => {
  for (const source of [lakeSource(), appSource()]) {
    const kind = serverKind(source);
    const result = await kind.test(source);
    assertNoPath(result);
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.lock?.holds, true);
    assert.equal(result.layout, source.id === "lake" ? "directory" : "database");
    assert.match(result.server?.version ?? "", /^DuckDB \d+\.\d+/);
    const facts = kind.testFacts(result);
    assert.ok(facts && "duckdb" in facts);

    const refresh = await kind.refresh(source);
    assertNoPath(refresh);
    // The same tables, never one more: the directory's `neighbor`-like files
    // and the database's other tables stay out until an author adds them.
    assert.deepEqual(
      refresh.config.kind === "duckdb" && refresh.config.tables.map((t) => t.name),
      source.config.kind === "duckdb" && source.config.tables.map((t) => t.name),
    );
    const diff = kind.refreshDiff(source, refresh);
    assert.equal(
      kind.refreshDigest(refresh),
      kind.refreshDigest(await kind.refresh(source)),
    );
    if (source.id === "lake") {
      assert.deepEqual(
        result.tables?.map((t) => [t.table, t.reachable]),
        [
          ["metrics", true],
          ["hosts", true],
          ["gone", false],
        ],
      );
      assert.deepEqual(refresh.missingTables, ["gone"]);
      // The file has columns the stored catalog did not: they arrive exposed.
      assert.ok("tables" in diff);
      const metrics = diff.tables.find((t) => t.table === "metrics");
      assert.deepEqual(
        metrics?.added.map((c) => c.name),
        ["tz", "v"],
      );
    } else {
      assert.deepEqual(refresh.missingTables, []);
      // The author's hidden column stays hidden through a refresh.
      const requests =
        refresh.config.kind === "duckdb" ? refresh.config.tables[0] : undefined;
      assert.equal(requests?.columns.find((c) => c.name === "token")?.exposed, false);
    }
  }
});

test("a panel runs through the poller's executor, and the plan view names no path", async () => {
  const source = lakeSource();
  const executor = makePanelExecutor(async () => source);
  const query = PanelQuery.parse({
    sourceId: "lake",
    sql: "SELECT ts, v FROM metrics",
    timeField: "ts",
  });
  const panel = Panel.parse({
    id: "p",
    title: "P",
    viz: "line",
    query,
    layout: { x: 0, y: 0, w: 6, h: 4 },
  });
  const events = await executor(
    panel as Parameters<typeof executor>[0],
    { from: minutes(0), to: minutes(3) },
    "ws",
    {},
    {},
  );
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.type, "panel", JSON.stringify(event));
  assert.ok("rows" in event && event.rows.length === 3);

  const kind = serverKind(source);
  const plan = kind.plan(source, query, {
    from: minutes(0),
    to: minutes(3),
    rowFilter: null,
  });
  const view = kind.planView({
    source,
    query,
    plan,
    timeRange: { from: "now-1h", to: "now" },
  });
  assertNoPath(view);
  assert.ok(
    "session" in view && view.session.includes("SET lock_configuration=true"),
    JSON.stringify(view),
  );
});

test("the path picker lists names directly under the root, and nothing the guard would refuse (#573)", async () => {
  // Beside the fixtures: a hidden directory, a file that is neither, a
  // directory whose name says database, a nested directory, and a symlink
  // that leads out of the root. None of them is offered.
  mkdirSync(join(root, ".cache"), { recursive: true });
  mkdirSync(join(root, "weird.duckdb"), { recursive: true });
  mkdirSync(join(root, "other", "nested"), { recursive: true });
  writeFileSync(join(root, "notes.txt"), "not a source\n");
  symlinkSync(base, join(root, "escape"));
  symlinkSync(join(root, "lake"), join(root, "lake-link"));

  const listed = await listSourcePaths();
  assert.deepEqual(listed, [
    { name: "app.duckdb", layout: "database" },
    { name: "lake", layout: "directory" },
    // A symlink that stays inside the root is what it points at.
    { name: "lake-link", layout: "directory" },
    { name: "other", layout: "directory" },
  ]);
  for (const entry of listed) {
    assert.deepEqual(Object.keys(entry).sort(), ["layout", "name"]);
    assert.ok(!entry.name.includes("/"), "one level, names only");
  }

  // The route's answer is that list, or a refusal naming the variable.
  const menu = await duckdbPathMenu();
  assert.deepEqual(menu, { ok: true, paths: listed });
  assertNoPath(menu);
  writable.duckdbSourcesDir = "";
  try {
    assert.deepEqual(await duckdbPathMenu(), { ok: false, error: SOURCES_DIR_UNSET });
    writable.duckdbSourcesDir = join(base, "missing");
    const missing = await duckdbPathMenu();
    assert.equal(missing.ok, false);
    assert.match(!missing.ok ? missing.error : "", /DUCKDB_SOURCES_DIR/);
    assertNoPath(missing);
  } finally {
    writable.duckdbSourcesDir = root;
  }
});

test("the path route is source-admin only, rate limited, and answers the menu alone (#573)", () => {
  const route = readFileSync(
    new URL("../src/app/api/sources/duckdb/paths/route.ts", import.meta.url),
    "utf8",
  );
  const authorized = route.indexOf('assertAuthorized(identity, "source:manage"');
  assert.ok(authorized > 0, "authorized on source:manage");
  assert.ok(authorized < route.indexOf("duckdbPathMenu()"), "before anything is read");
  assert.match(route, /requireIdentity\(\)/);
  assert.match(route, /rateStore\.take/);
  assert.match(route, /json\(await duckdbPathMenu\(\)/);
  // Who that is: a source admin of the workspace, never a viewer of it.
  const admin = parseGroups("sam", ["/workspaces/ops/source-admin"]);
  const viewer = parseGroups("vic", ["/workspaces/ops/viewer"]);
  assert.equal(can(admin, "source:manage", { workspaceId: "ops" }), true);
  assert.equal(can(viewer, "source:manage", { workspaceId: "ops" }), false);
  assert.equal(can(admin, "source:manage", { workspaceId: "fin" }), false);
});

test("discovery reads a path's tables and columns into the allowlist menu, naming no path (#573)", async () => {
  const lake = await duckdbDiscovery("lake").tables();
  assert.deepEqual(
    lake.map((t) => [t.name, t.columns.map((c) => c.name)]),
    [
      ["hosts", ["host", "rack"]],
      ["metrics", ["ts", "tz", "host", "v"]],
    ],
  );
  assert.equal(lake.find((t) => t.name === "metrics")?.columns[0]?.type, "TIMESTAMP");
  const app = await duckdbDiscovery("app.duckdb").tables();
  assert.deepEqual(
    app.map((t) => t.name),
    ["requests"],
  );
  // A file that is not a database fails in the engine's open, whose message
  // names the file: scrubbed like every other.
  writeFileSync(join(root, "broken.duckdb"), "not a database\n");
  for (const path of [
    "missing",
    "notes.txt",
    "escape",
    "../root/lake",
    "broken.duckdb",
  ]) {
    await assert.rejects(duckdbDiscovery(path).tables(), (err: Error) => {
      assertNoPath(err.message);
      return true;
    });
  }
  // The route records which kind of thing it opened, never where.
  const routeText = readFileSync(
    new URL("../src/app/api/sources/discover/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(routeText, /\{ kind: "duckdb", layout: duckdbLayout\(body\.path\) \}/);
});

test("the Add source dialog offers DuckDB only when the server can hold one (#573)", async () => {
  const offered = async () =>
    Object.fromEntries((await sourceKindAvailability()).map((k) => [k.kind, k]));
  // Set up: offered, with no reason.
  assert.deepEqual((await offered()).duckdb, { kind: "duckdb", available: true });
  // The other kinds need nothing of the server.
  assert.equal((await offered()).timescaledb?.available, true);
  assert.equal((await offered()).prometheus?.available, true);

  writable.duckdbSourcesDir = "";
  try {
    assert.deepEqual((await offered()).duckdb, {
      kind: "duckdb",
      available: false,
      reason: SOURCES_DIR_UNSET,
    });
  } finally {
    writable.duckdbSourcesDir = root;
  }

  setDuckDbLoaderForTests(() =>
    Promise.reject(Object.assign(new Error("no binding"), { code: "MODULE_NOT_FOUND" })),
  );
  try {
    assert.deepEqual((await offered()).duckdb, {
      kind: "duckdb",
      available: false,
      reason: DUCKDB_UNAVAILABLE,
    });
  } finally {
    setDuckDbLoaderForTests(null);
  }
});

test("no log line carries a path", () => {
  for (const line of lines) assertNoPath(line);
});

test("without the binding the kind says so, and nothing else breaks", async () => {
  setDuckDbLoaderForTests(() =>
    Promise.reject(
      Object.assign(new Error(`cannot load ${base}/x.node`), {
        code: "ERR_DLOPEN_FAILED",
      }),
    ),
  );
  try {
    const source = record("busy", { ...lakeSource().config });
    const kind = serverKind(source);
    assert.equal(await kind.checkConfig(source.config), DUCKDB_UNAVAILABLE);
    const result = await kind.test(source);
    assert.equal(result.ok, false);
    assert.equal(result.message, DUCKDB_UNAVAILABLE);
    await assert.rejects(
      run(source, "SELECT ts, host FROM metrics", "ts"),
      (err) => err instanceof QueryExecutionError && err.message === DUCKDB_UNAVAILABLE,
    );
    // The failed load was logged once, by its code, not its path.
    for (const line of lines) assertNoPath(line);
    assert.ok(lines.some((l) => l.includes("ERR_DLOPEN_FAILED")));
  } finally {
    setDuckDbLoaderForTests(null);
  }
});
