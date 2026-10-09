import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/*
 * The Prometheus client and executor (#385) against a fake endpoint on a
 * loopback port. `./support/prometheus-env` sets what the client reads before
 * `config` loads, so it is imported first.
 */
import "./support/prometheus-env";
import { Panel, PanelQuery } from "@/lib/ir";
import { asQueryPanel } from "./support/panels";
import { makePanelExecutor } from "@/lib/poller/registry";
import {
  PrometheusUnavailableError,
  prometheusRequest,
  runPromqlPlan,
} from "@/lib/prometheus/client";
import { rowsFromPrometheus, seriesName } from "@/lib/prometheus/rows";
import { SourceConfig } from "@/lib/registry";
import { QueryExecutionError } from "@/lib/sources/execution";
import { serverKind } from "@/lib/sources/server/registry";

interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  form: URLSearchParams;
}

const seen: Seen[] = [];
let reply: (seen: Seen) => {
  status: number;
  body: string;
  headers?: Record<string, string>;
} = () => ({
  status: 200,
  body: JSON.stringify({ status: "success", data: { resultType: "vector", result: [] } }),
});

let server: Server;
let base: string;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const entry: Seen = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        form: new URLSearchParams(body),
      };
      seen.push(entry);
      const answer = reply(entry);
      res.writeHead(answer.status, {
        "Content-Type": "application/json",
        ...(answer.headers ?? {}),
      });
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/prom`;
});

after(() => {
  server.close();
});

function source(
  auth: "none" | "bearer" | "basic",
  overrides: Record<string, unknown> = {},
) {
  const config = SourceConfig.parse({
    kind: "prometheus",
    url: base,
    auth,
    metrics: [
      {
        name: "http_requests_total",
        type: "counter",
        labels: ["job", "route", "tenant"],
      },
      { name: "up", type: "gauge", labels: ["job", "instance", "tenant"] },
    ],
    ...overrides,
  });
  return {
    id: "prom",
    workspaceId: "ws",
    name: "Prometheus",
    kind: "prometheus" as const,
    config,
    secretRef: auth === "none" ? null : "PROM_TEST",
    catalogRefreshedAt: null,
    catalogMissingTables: [],
    createdBy: "u",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    tombstonedAt: null,
  };
}

const target = (auth: "none" | "bearer" | "basic") => {
  const s = source(auth);
  return {
    id: s.id,
    workspaceId: s.workspaceId,
    secretRef: s.secretRef,
    config: { url: base, auth },
  };
};

const ok = (data: unknown) => () => ({
  status: 200,
  body: JSON.stringify({ status: "success", data }),
});

test("a range plan is POSTed to query_range with the server's start, end, step and timeout", async () => {
  seen.length = 0;
  reply = ok({ resultType: "matrix", result: [] });
  await runPromqlPlan(target("bearer"), {
    instant: false,
    expr: "up",
    start: new Date("2026-10-09T11:00:00Z"),
    end: new Date("2026-10-09T12:00:00Z"),
    stepSeconds: 15,
    timeoutMs: 20_000,
  });
  const [request] = seen;
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/prom/api/v1/query_range");
  assert.equal(request.headers.accept, "application/json");
  assert.equal(request.headers.authorization, "Bearer t0ken");
  assert.deepEqual(Object.fromEntries(request.form), {
    query: "up",
    timeout: "20s",
    start: "1791543600.000",
    end: "1791547200.000",
    step: "15s",
  });
});

test("an instant plan asks for one time, with basic credentials when the source uses them", async () => {
  seen.length = 0;
  reply = ok({ resultType: "vector", result: [] });
  await runPromqlPlan(target("basic"), {
    instant: true,
    expr: "up",
    time: new Date("2026-10-09T12:00:00Z"),
    timeoutMs: 5_000,
  });
  assert.equal(seen[0].path, "/prom/api/v1/query");
  assert.equal(seen[0].form.get("time"), "1791547200.000");
  assert.equal(
    seen[0].headers.authorization,
    `Basic ${Buffer.from("reader:pa:ss").toString("base64")}`,
  );
});

test("a source with no auth sends no credentials at all", async () => {
  seen.length = 0;
  reply = ok({ resultType: "vector", result: [] });
  await prometheusRequest(target("none"), "query", new URLSearchParams({ query: "up" }));
  assert.equal(seen[0].headers.authorization, undefined);
});

test("bad_data is the author's to fix and keeps Prometheus's message; a 500 is opaque", async () => {
  reply = () => ({
    status: 400,
    body: JSON.stringify({
      status: "error",
      errorType: "bad_data",
      error: "parse error at char 3",
    }),
  });
  await assert.rejects(
    prometheusRequest(target("none"), "query", new URLSearchParams({ query: "up" })),
    (err) =>
      err instanceof QueryExecutionError && err.message === "parse error at char 3",
  );
  reply = () => ({
    status: 422,
    body: JSON.stringify({
      status: "error",
      errorType: "execution",
      error: "too many samples",
    }),
  });
  await assert.rejects(
    prometheusRequest(target("none"), "query", new URLSearchParams({ query: "up" })),
    (err) => err instanceof QueryExecutionError && err.message === "too many samples",
  );
  reply = () => ({
    status: 503,
    body: JSON.stringify({
      status: "error",
      errorType: "timeout",
      error: "query timed out",
    }),
  });
  await assert.rejects(
    prometheusRequest(target("none"), "query", new URLSearchParams({ query: "up" })),
    (err) => err instanceof PrometheusUnavailableError,
  );
  reply = () => ({ status: 502, body: "<html>bad gateway</html>" });
  await assert.rejects(
    prometheusRequest(target("none"), "query", new URLSearchParams({ query: "up" })),
    (err) => err instanceof PrometheusUnavailableError,
  );
});

test("a redirect is refused, never followed", async () => {
  reply = () => ({
    status: 302,
    body: "",
    headers: { Location: "http://169.254.169.254/" },
  });
  await assert.rejects(
    prometheusRequest(target("none"), "query", new URLSearchParams({ query: "up" })),
    (err) => err instanceof PrometheusUnavailableError && /redirect/.test(err.message),
  );
});

test("an answer over the byte cap is cut off as it arrives", async () => {
  reply = () => ({
    status: 200,
    body: `{"status":"success","data":"${"x".repeat(70_000)}"}`,
  });
  await assert.rejects(
    prometheusRequest(target("none"), "query", new URLSearchParams({ query: "up" })),
    (err) => err instanceof QueryExecutionError && /larger than 64 KiB/.test(err.message),
  );
});

test("a URL outside the allowlist's reach is refused before any request", async () => {
  await assert.rejects(
    prometheusRequest(
      { ...target("none"), config: { url: "http://10.1.2.3:9090", auth: "none" } },
      "query",
      new URLSearchParams({ query: "up" }),
    ),
    (err) =>
      err instanceof PrometheusUnavailableError &&
      /SOURCE_URL_ALLOWLIST/.test(err.message),
  );
});

/* ------------------------------------------------------------------------- */
/* Rows                                                                       */
/* ------------------------------------------------------------------------- */

test("a matrix becomes wide rows: time, then one column per series, uneven timestamps and all", () => {
  const result = rowsFromPrometheus(
    {
      resultType: "matrix",
      result: [
        {
          metric: { __name__: "http_requests_total", route: "/a", job: "api" },
          values: [
            [1000, "1"],
            [1015, "2"],
          ],
        },
        {
          metric: { __name__: "http_requests_total", route: "/b", job: "api" },
          values: [
            [1015, "NaN"],
            [1030, "+Inf"],
          ],
        },
      ],
    },
    10,
  );
  const a = '{job="api", route="/a"}';
  const b = '{job="api", route="/b"}';
  assert.deepEqual(result.columns, ["time", a, b]);
  assert.deepEqual(result.rows, [
    { time: "1970-01-01T00:16:40.000Z", [a]: 1, [b]: null },
    { time: "1970-01-01T00:16:55.000Z", [a]: 2, [b]: null },
    { time: "1970-01-01T00:17:10.000Z", [a]: null, [b]: null },
  ]);
});

test("a series keeps its metric name when the names differ, and {} when it has no labels", () => {
  assert.equal(seriesName({ __name__: "up", job: "x" }, true), 'up{job="x"}');
  assert.equal(seriesName({ __name__: "up" }, false), "{}");
  assert.equal(seriesName({ b: "2", a: "1" }, false), '{a="1", b="2"}');
});

test("an instant vector is one row per series, labels sorted, then value; a scalar is one value", () => {
  assert.deepEqual(
    rowsFromPrometheus(
      {
        resultType: "vector",
        result: [
          { metric: { route: "/a", job: "api" }, value: [1000, "3.5"] },
          { metric: { route: "/b" }, value: [1000, "-Inf"] },
        ],
      },
      10,
    ),
    {
      columns: ["job", "route", "value"],
      rows: [
        { job: "api", route: "/a", value: 3.5 },
        { job: null, route: "/b", value: null },
      ],
    },
  );
  assert.deepEqual(
    rowsFromPrometheus({ resultType: "scalar", result: [1000, "42"] }, 10),
    {
      columns: ["value"],
      rows: [{ value: 42 }],
    },
  );
});

test("too many series, or a native histogram, is the author's to narrow", () => {
  const many = Array.from({ length: 4 }, (_, i) => ({
    metric: { route: `/${i}` },
    values: [[1000, "1"]],
  }));
  assert.throws(
    () => rowsFromPrometheus({ resultType: "matrix", result: many }, 3),
    (err) =>
      err instanceof QueryExecutionError && /4 series, more than the 3/.test(err.message),
  );
  assert.throws(
    () =>
      rowsFromPrometheus(
        {
          resultType: "vector",
          result: [{ metric: {}, histogram: [1000, { count: "1" }] }],
        },
        3,
      ),
    (err) => err instanceof QueryExecutionError && /histogram_quantile/.test(err.message),
  );
});

/* ------------------------------------------------------------------------- */
/* Through the kind and the poller                                            */
/* ------------------------------------------------------------------------- */

test("a PromQL panel runs through the kind: checked, planned with the tenant, executed into rows", async () => {
  seen.length = 0;
  reply = ok({
    resultType: "matrix",
    result: [{ metric: { route: "/a" }, values: [[1791543600, "5"]] }],
  });
  const prom = source("bearer", { rowFilter: { label: "tenant", claim: "sub" } });
  const kind = serverKind(prom);
  const query = PanelQuery.parse({
    sourceId: "prom",
    promql: 'sum by (route) (rate(http_requests_total{job="api"}[5m]))',
  });
  assert.deepEqual(await kind.check(prom, query), { ok: true, error: undefined });
  const plan = kind.plan(prom, query, {
    from: new Date("2026-10-09T11:00:00Z"),
    to: new Date("2026-10-09T12:00:00Z"),
    rowFilter: { column: "tenant", value: "acme" },
  });
  const result = await kind.execute(prom, plan);
  assert.equal(
    seen[0].form.get("query"),
    'sum by (route) (rate(http_requests_total{job="api", tenant="acme"}[5m]))',
  );
  assert.deepEqual(result.columns, ["time", '{route="/a"}']);
  // SQL against a Prometheus source is refused like a table it does not have.
  assert.deepEqual(
    await kind.check(prom, PanelQuery.parse({ sourceId: "prom", sql: "SELECT 1" })),
    {
      ok: false,
      error: 'source "prom" answers PromQL; this query is SQL',
    },
  );
});

test("the poller runs a PromQL panel, and reports a tombstone or another workspace's source the same way", async () => {
  reply = ok({ resultType: "vector", result: [{ metric: {}, value: [1000, "7"] }] });
  const prom = source("none");
  const panel = asQueryPanel(
    Panel.parse({
      id: "up",
      title: "Up",
      viz: "stat",
      layout: { x: 0, y: 0, w: 3, h: 2 },
      query: { sourceId: "prom", promql: "sum(up)", instant: true },
    }),
  );
  const window = { from: new Date(0), to: new Date(1_000_000) };
  const run = makePanelExecutor(async () => prom);
  const events = await run(panel, window, "ws", {}, {});
  assert.equal(events[0].type, "panel");
  if (events[0].type === "panel") assert.deepEqual(events[0].rows, [{ value: 7 }]);

  const gone = makePanelExecutor(async () => ({
    ...prom,
    tombstonedAt: "2026-01-01T00:00:00Z",
  }));
  assert.equal((await gone(panel, window, "ws", {}, {}))[0].type, "tombstone");
  assert.equal((await run(panel, window, "other-ws", {}, {}))[0].type, "tombstone");
});
