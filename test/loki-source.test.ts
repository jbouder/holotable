import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * The Loki client and executor (#562) against a fake endpoint on a loopback
 * port. `./support/loki-env` sets what the client reads before `config`
 * loads, so it is imported first.
 */
import "./support/loki-env";
import { catalogHealth, describeCatalogHealth } from "@/lib/catalog/health";
import { Panel, PanelQuery } from "@/lib/ir";
import { createLogger, setLogger } from "@/lib/log";
import { LokiUnavailableError } from "@/lib/loki/client";
import { rowsFromLoki } from "@/lib/loki/rows";
import { makePanelExecutor } from "@/lib/poller/registry";
import { rowsFromPrometheus } from "@/lib/prometheus/rows";
import { SourceConfig, type SourceRecord } from "@/lib/registry";
import { QueryExecutionError } from "@/lib/sources/execution";
import { wrongLanguage } from "@/lib/sources/registry";
import { MAX_LABEL_VALUES } from "@/lib/sources/kinds/loki";
import { lokiDiscovery, serverKind } from "@/lib/sources/server/registry";
import { type FakeLoki, getOnly, lokiSuccess, startFakeLoki } from "./support/fake-loki";
import { asQueryPanel } from "./support/panels";

let fake: FakeLoki;

before(async () => {
  fake = await startFakeLoki("/loki-prefix");
});

after(async () => {
  await fake.close();
});

beforeEach(() => {
  fake.seen.length = 0;
});

function source(
  auth: "none" | "bearer" | "basic",
  overrides: Record<string, unknown> = {},
): SourceRecord {
  const config = SourceConfig.parse({
    kind: "loki",
    url: fake.url,
    auth,
    labels: [
      { name: "app", values: ["api", "web"] },
      { name: "env", values: ["prod"] },
      { name: "tenant", values: [] },
    ],
    ...overrides,
  });
  return {
    id: "logs",
    workspaceId: "ws",
    name: "Logs",
    kind: "loki",
    config,
    secretRef: auth === "none" ? null : "LOKI_TEST",
    catalogRefreshedAt: null,
    catalogMissingTables: [],
    createdBy: "u",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    tombstonedAt: null,
  };
}

const FROM = new Date("2026-10-09T11:00:00Z");
const TO = new Date("2026-10-09T12:00:00Z");
const ns = (d: Date) => `${d.getTime()}000000`;

function streams(...entries: [Record<string, string>, unknown[][]][]) {
  return lokiSuccess({
    resultType: "streams",
    result: entries.map(([stream, values]) => ({ stream, values })),
  });
}

test("a log query is a GET to query_range carrying only the server's start, end, limit and direction", async () => {
  fake.handle = getOnly(() => streams());
  const loki = source("bearer", { rowFilter: { label: "tenant", claim: "sub" } });
  const kind = serverKind(loki);
  const query = PanelQuery.parse({ sourceId: "logs", logql: '{app="api"} |= "error"' });
  assert.deepEqual(await kind.check(loki, query), { ok: true, error: undefined });
  // The panel asks for more lines than the server allows: the cap wins.
  const plan = kind.plan(loki, query, {
    from: FROM,
    to: TO,
    rowFilter: { column: "tenant", value: "acme" },
    maxRows: 500,
  });
  await kind.execute(loki, plan);
  const [request] = fake.seen;
  assert.equal(request.method, "GET");
  assert.equal(request.path, "/loki/api/v1/query_range");
  assert.equal(request.headers.authorization, "Bearer l0ki-t0ken-secret");
  assert.deepEqual(Object.fromEntries(request.query), {
    query: '{app="api", tenant="acme"} |= "error"',
    start: ns(FROM),
    end: ns(TO),
    limit: "50",
    direction: "backward",
  });

  // A panel that asks for fewer lines gets fewer.
  fake.seen.length = 0;
  await kind.execute(
    loki,
    kind.plan(loki, query, { from: FROM, to: TO, rowFilter: null, maxRows: 10 }),
  );
  assert.equal(fake.seen[0].query.get("limit"), "10");
});

test("a metric query sends the server's step, and an instant one its time; neither a limit", async () => {
  fake.handle = getOnly(() => lokiSuccess({ resultType: "matrix", result: [] }));
  const loki = source("basic");
  const kind = serverKind(loki);
  const range = PanelQuery.parse({
    sourceId: "logs",
    logql: 'sum(count_over_time({app="api"} [5m]))',
  });
  await kind.execute(
    loki,
    kind.plan(loki, range, { from: FROM, to: TO, rowFilter: null }),
  );
  const sent = fake.seen[0];
  assert.equal(sent.path, "/loki/api/v1/query_range");
  assert.deepEqual([...sent.query.keys()].sort(), ["end", "query", "start", "step"]);
  assert.match(sent.query.get("step") ?? "", /^\d+s$/);
  assert.equal(
    sent.headers.authorization,
    `Basic ${Buffer.from("reader:pa:ss-secret").toString("base64")}`,
  );

  fake.handle = getOnly(() => lokiSuccess({ resultType: "vector", result: [] }));
  fake.seen.length = 0;
  const instant = PanelQuery.parse({ ...range, instant: true });
  await kind.execute(
    loki,
    kind.plan(loki, instant, { from: FROM, to: TO, rowFilter: null }),
  );
  assert.equal(fake.seen[0].path, "/loki/api/v1/query");
  assert.deepEqual(Object.fromEntries(fake.seen[0].query), {
    query: 'sum(count_over_time({app="api"} [5m]))',
    time: ns(TO),
  });
  // A source with no auth sends no credential.
  fake.seen.length = 0;
  const open = source("none");
  await serverKind(open).execute(
    open,
    serverKind(open).plan(open, instant, { from: FROM, to: TO, rowFilter: null }),
  );
  assert.equal(fake.seen[0].headers.authorization, undefined);
});

test("streams become log rows, newest first, labels as columns, cut at the limit and said", () => {
  const data = {
    resultType: "streams",
    result: [
      {
        stream: { app: "api", level: "error" },
        values: [
          ["1791547200000000000", "older"],
          ["1791547260000000000", "newest", { parsed: { route: "/a" } }],
        ],
      },
      {
        stream: { app: "web", message: "a label named message" },
        values: [["1791547230000000000", "middle"]],
      },
    ],
  };
  const whole = rowsFromLoki(data, { maxSeries: 3, limit: 10, direction: "backward" });
  assert.deepEqual(whole.columns, [
    "time",
    "message",
    "app",
    "level",
    "message_label",
    "route",
  ]);
  assert.deepEqual(
    whole.rows.map((r) => [r.time, r.message]),
    [
      ["2026-10-09T12:01:00.000Z", "newest"],
      ["2026-10-09T12:00:30.000Z", "middle"],
      ["2026-10-09T12:00:00.000Z", "older"],
    ],
  );
  assert.deepEqual(whole.rows[0], {
    time: "2026-10-09T12:01:00.000Z",
    message: "newest",
    app: "api",
    level: "error",
    route: "/a",
    message_label: null,
  });
  assert.equal(whole.truncated, undefined);

  // As many lines as were asked for: more matched than were read.
  const full = rowsFromLoki(data, { maxSeries: 3, limit: 3, direction: "backward" });
  assert.deepEqual(full.truncated, { stage: "entries", kept: 3 });
  // More than were asked for, from an endpoint that ignored the limit: cut here.
  const cut = rowsFromLoki(data, { maxSeries: 3, limit: 2, direction: "backward" });
  assert.deepEqual(
    cut.rows.map((r) => r.message),
    ["newest", "middle"],
  );
  assert.deepEqual(cut.truncated, { stage: "entries", kept: 2 });
});

test("a matrix or a vector is exactly what a Prometheus answer becomes, series cap and all", () => {
  const matrix = {
    resultType: "matrix",
    result: [
      {
        metric: { route: "/a" },
        values: [
          [1000, "1"],
          [1015, "2"],
        ],
      },
      { metric: { route: "/b" }, values: [[1015, "3"]] },
    ],
  };
  assert.deepEqual(
    rowsFromLoki(matrix, { maxSeries: 3, limit: 10, direction: "backward" }),
    rowsFromPrometheus(matrix, 3),
  );
  const vector = {
    resultType: "vector",
    result: [{ metric: { app: "api" }, value: [1000, "7"] }],
  };
  assert.deepEqual(
    rowsFromLoki(vector, { maxSeries: 3, limit: 10, direction: "backward" }),
    rowsFromPrometheus(vector, 3),
  );
  const many = {
    resultType: "matrix",
    result: Array.from({ length: 4 }, (_, i) => ({
      metric: { i: `${i}` },
      values: [[1000, "1"]],
    })),
  };
  assert.throws(
    () => rowsFromLoki(many, { maxSeries: 3, limit: 10, direction: "backward" }),
    (err) =>
      err instanceof QueryExecutionError && /4 series, more than the 3/.test(err.message),
  );
});

test("a refused query keeps Loki's words; an endpoint failure is opaque, logged by id with no URL or credential", async () => {
  const lines: string[] = [];
  const restore = setLogger(
    createLogger({
      sink: (line) => lines.push(line),
      env: { LOG_LEVEL: "debug", LOG_FORMAT: "json" },
    }),
  );
  try {
    const loki = source("bearer");
    const kind = serverKind(loki);
    const query = PanelQuery.parse({ sourceId: "logs", logql: '{app="api"}' });
    const plan = kind.plan(loki, query, { from: FROM, to: TO, rowFilter: null });

    fake.handle = () => ({
      status: 400,
      text: "parse error at line 1, col 2: syntax error",
    });
    await assert.rejects(
      kind.execute(loki, plan),
      (err) =>
        err instanceof QueryExecutionError &&
        err.message === "parse error at line 1, col 2: syntax error",
    );

    fake.handle = () => ({ status: 500, text: `upstream ${fake.url} broke` });
    await assert.rejects(
      kind.execute(loki, plan),
      (err) => err instanceof LokiUnavailableError,
    );
    fake.handle = () => ({ status: 302, text: "" });
    await assert.rejects(
      kind.execute(loki, plan),
      (err) => err instanceof LokiUnavailableError,
    );

    const logged = lines.filter((l) => l.includes("loki.unavailable"));
    assert.equal(logged.length, 2);
    for (const line of lines) {
      assert.ok(line.includes('"sourceId":"logs"') || !line.includes("loki."), line);
      for (const secret of [fake.url, "127.0.0.1", "l0ki-t0ken-secret", "pa:ss-secret"]) {
        assert.ok(!line.includes(secret), `a log line carries ${secret}: ${line}`);
      }
    }

    // A result never carries where the source lives.
    fake.handle = getOnly(() =>
      streams([{ app: "api" }, [["1791547200000000000", "hi"]]]),
    );
    const result = await kind.execute(loki, plan);
    assert.ok(!JSON.stringify(result).includes(fake.url));
  } finally {
    restore();
  }
});

test("a PromQL or SQL query against a Loki source is refused like a table it does not have", async () => {
  const loki = source("none");
  const kind = serverKind(loki);
  for (const [query, written] of [
    [PanelQuery.parse({ sourceId: "logs", promql: "up" }), "PromQL"],
    [PanelQuery.parse({ sourceId: "logs", sql: "SELECT 1" }), "SQL"],
  ] as const) {
    const error = `source "logs" answers LogQL; this query is ${written}`;
    assert.equal(wrongLanguage(loki, query), error);
    assert.deepEqual(await kind.check(loki, query), { ok: false, error });
    assert.throws(() => kind.plan(loki, query, { from: FROM, to: TO, rowFilter: null }), {
      message: error,
    });
  }
  // A selector on no allowlisted label is the guard's refusal.
  const unanchored = await kind.check(
    loki,
    PanelQuery.parse({ sourceId: "logs", logql: '{pod="x"}' }),
  );
  assert.equal(unanchored.ok, false);
});

test("a label-values variable is a GET over the last LOGQL_MAX_RANGE, under the tenant matcher", async () => {
  fake.handle = getOnly(() => lokiSuccess(["web", "api", "api"]));
  const loki = source("none", { rowFilter: { label: "tenant", claim: "sub" } });
  const values = await serverKind(loki).labelValues(
    loki,
    { sourceId: "logs", label: "app" },
    { column: "tenant", value: "acme" },
  );
  assert.deepEqual(values, ["api", "web"]);
  const [request] = fake.seen;
  assert.equal(request.method, "GET");
  assert.equal(request.path, "/loki/api/v1/label/app/values");
  assert.equal(request.query.get("query"), '{tenant="acme"}');
  const span =
    Number(
      BigInt(request.query.get("end") ?? "0") - BigInt(request.query.get("start") ?? "0"),
    ) / 1e6;
  assert.equal(span, 7 * 86_400_000);
});

test("the poller runs a logs panel into rows the logs kind draws, with its truncation", async () => {
  fake.handle = getOnly(() =>
    streams([
      { app: "api", level: "warn" },
      Array.from({ length: 5 }, (_, i) => [`17915472${i}0000000000`, `line ${i}`]),
    ]),
  );
  const loki = source("none");
  const panel = asQueryPanel(
    Panel.parse({
      id: "errors",
      title: "Errors",
      viz: "logs",
      layout: { x: 0, y: 0, w: 6, h: 4 },
      options: { limit: 5 },
      query: { sourceId: "logs", logql: '{app="api"}' },
    }),
  );
  const run = makePanelExecutor(async () => loki);
  const [event] = await run(panel, { from: FROM, to: TO }, "ws", {}, {});
  assert.equal(event.type, "panel");
  if (event.type !== "panel") return;
  assert.equal(fake.seen[0].query.get("limit"), "5");
  assert.deepEqual(event.columns, ["time", "message", "app", "level"]);
  assert.equal(event.rows[0].message, "line 4");
  assert.deepEqual(event.truncated, { stage: "entries", kept: 5 });
});

test("the connection test and a refresh read labels with GET and report nothing of the URL", async () => {
  fake.handle = getOnly((request) => {
    if (request.path === "/ready") return { text: "ready" };
    if (request.path === "/loki/api/v1/status/buildinfo")
      return { json: { version: "3.4.2" } };
    if (request.path === "/loki/api/v1/labels") return lokiSuccess(["app", "env"]);
    if (request.path === "/loki/api/v1/label/app/values")
      return lokiSuccess(["api", "worker"]);
    if (request.path === "/loki/api/v1/label/env/values") return lokiSuccess(["prod"]);
    return lokiSuccess([]);
  });
  const loki = source("bearer");
  const kind = serverKind(loki);
  const result = await kind.test(loki);
  assert.equal(result.ok, true);
  assert.deepEqual(result.endpoint, { product: "Loki", version: "3.4.2" });
  assert.deepEqual(
    result.labels?.map((l) => [l.label, l.reachable]),
    [
      ["app", true],
      ["env", true],
      ["tenant", false],
    ],
  );
  assert.ok(!JSON.stringify(result).includes(fake.url));

  const refresh = await kind.refresh(loki);
  assert.deepEqual(refresh.missingTables, ["tenant"]);
  assert.deepEqual(kind.refreshDiff(loki, refresh), {
    missingLabels: ["tenant"],
    restoredLabels: [],
    labels: [{ label: "app", addedValues: ["worker"], removedValues: ["web"] }],
  });
  assert.ok(fake.seen.every((r) => r.method === "GET"));
});

test("discovery reads label names and one label's values with GET, over the server's last hour, capped (#563)", async () => {
  fake.handle = getOnly((request) => {
    if (request.path === "/loki/api/v1/labels")
      return lokiSuccess(["namespace", "app", "__stream_shard__", "bad label", 7]);
    if (request.path === "/loki/api/v1/label/app/values")
      return lokiSuccess(
        Array.from({ length: MAX_LABEL_VALUES + 30 }, (_, i) => `v${i}`).concat("v1"),
      );
    return lokiSuccess([]);
  });
  const discovery = lokiDiscovery({
    workspaceId: "ws",
    url: fake.url,
    auth: "bearer",
    secretRef: "LOKI_TEST",
  });
  assert.equal(await discovery.checkUrl(), null);
  // Reserved and malformed names are not offered; the menu is sorted.
  assert.deepEqual(await discovery.labels(), ["app", "namespace"]);
  const values = await discovery.values("app");
  assert.equal(values.length, MAX_LABEL_VALUES);
  assert.equal(new Set(values).size, values.length);

  assert.equal(fake.seen.length, 2);
  for (const request of fake.seen) {
    assert.equal(request.method, "GET");
    assert.equal(request.headers.authorization, "Bearer l0ki-t0ken-secret");
    // The window is the server's: PROMETHEUS_DISCOVERY_WINDOW, an hour by default.
    const span =
      BigInt(request.query.get("end") ?? "0") - BigInt(request.query.get("start") ?? "0");
    assert.equal(span, BigInt(3_600_000) * BigInt(1_000_000));
  }

  // A URL outside SOURCE_URL_ALLOWLIST is refused before anything is asked.
  const outside = lokiDiscovery({
    workspaceId: "ws",
    url: "http://10.0.0.7:3100",
    auth: "none",
    secretRef: null,
  });
  assert.notEqual(await outside.checkUrl(), null);
});

test("the discover route authorizes source:manage and the grant before asking any kind (#563)", () => {
  const text = readFileSync(
    new URL("../src/app/api/sources/discover/route.ts", import.meta.url),
    "utf8",
  );
  const authorize = text.indexOf('assertAuthorized(identity, "source:manage"');
  const grant = text.indexOf("requireGrantedSecretRef(body.secretRef");
  const ask = text.indexOf("DISCOVER[body.kind]");
  assert.ok(authorize > 0 && grant > authorize && ask > grant);
  // Each HTTP kind checks its URL before it asks the endpoint anything.
  assert.equal(text.match(/await discovery\.checkUrl\(\)/g)?.length, 2);
  assert.match(text, /lokiDiscovery\(/);
  assert.match(text, /action: "source\.discover"/);
});

test("health speaks of labels and the endpoint for a Loki source; a label with no streams is missing (#563)", () => {
  const loki = {
    ...source("none"),
    name: "Logs",
    catalogRefreshedAt: "2026-10-09T11:00:00Z",
    catalogMissingTables: ["tenant"],
  };
  const health = catalogHealth(loki, { now: new Date("2026-10-09T12:00:00Z") });
  assert.equal(health.state, "drifted");
  assert.equal(health.entries, "label");
  assert.equal(health.liveTableCount, 2);
  assert.equal(
    describeCatalogHealth(loki, health),
    '1 label in "Logs" no longer exists in the endpoint (tenant). Refresh the catalog for source logs and adjust its labels.',
  );
  const never = catalogHealth({
    ...loki,
    catalogRefreshedAt: null,
    catalogMissingTables: [],
  });
  assert.match(
    describeCatalogHealth(loki, never),
    /its labels and values are unverified and generated LogQL/,
  );

  const view = serverKind(loki).catalogView(loki, health, false);
  assert.deepEqual(Object.keys(view).sort(), [
    "canManage",
    "catalogHealth",
    "labels",
    "missingLabels",
  ]);
  assert.ok(!JSON.stringify(view).includes(fake.url));
});
