import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import "./support/prometheus-env";
import { catalogHealth, describeCatalogHealth } from "@/lib/catalog/health";
import {
  diffMetricCatalog,
  isUnchanged,
  summarizeCatalogDiff,
} from "@/lib/catalog/refresh";
import {
  discoverLabels,
  discoverMetrics,
  refreshPrometheusCatalog,
  testPrometheus,
} from "@/lib/prometheus/catalog";
import { SourceConfig, type SourceRecord } from "@/lib/registry";
import { hasFinding, summarizeMetrics, writeSurfaceHeadline } from "@/lib/source-test";
import type { PrometheusConfig } from "@/lib/sources/kinds/prometheus";
import { serverKind } from "@/lib/sources/server/registry";
import {
  type FakePrometheus,
  params,
  startFakePrometheus,
  success,
} from "./support/fake-prometheus";

/**
 * Managing a Prometheus source (#386): discovery, the connection test, the
 * catalog refresh, health and the browser, against a fake endpoint.
 */

let fake: FakePrometheus;

before(async () => {
  fake = await startFakePrometheus("/prom");
});

after(async () => {
  await fake.close();
});

function target(auth: "none" | "bearer" = "none") {
  return {
    id: "prom",
    workspaceId: "ws",
    secretRef: auth === "none" ? null : "PROM_TEST",
    config: { url: fake.url, auth },
  };
}

function cfg(
  metrics: { name: string; type?: string; labels?: string[] }[],
): PrometheusConfig {
  const parsed = SourceConfig.parse({
    kind: "prometheus",
    url: fake.url,
    auth: "none",
    metrics,
  });
  if (parsed.kind !== "prometheus") throw new Error("not prometheus");
  return parsed;
}

/** The labels each metric's series carry, keyed by the selector discovery sends. */
function labelsAnswer(byMetric: Record<string, string[]>) {
  return (request: { form: URLSearchParams }) => {
    const match = request.form.get("match[]") ?? "";
    const name = (/^\{__name__="(.*)"\}$/.exec(match)?.[1] ?? "").replace(/\\(.)/g, "$1");
    return success(byMetric[name] ?? []);
  };
}

test("discovery reads the metadata, sorted, and falls back to names when there is none", async () => {
  fake.seen.length = 0;
  fake.handle = (r) =>
    r.path === "/api/v1/metadata"
      ? success({
          up: [{ type: "gauge", help: "1 if the target is up." }],
          http_requests_total: [{ type: "counter", help: "Requests." }],
          weird: [{ type: "stateset" }],
        })
      : { status: 404 };
  assert.deepEqual(await discoverMetrics(target()), [
    { name: "http_requests_total", type: "counter", help: "Requests." },
    { name: "up", type: "gauge", help: "1 if the target is up." },
    { name: "weird", type: "unknown" },
  ]);
  assert.equal(fake.seen[0].method, "GET");

  fake.handle = (r) =>
    r.path === "/api/v1/metadata"
      ? success({})
      : r.path === "/api/v1/label/__name__/values"
        ? success(["up", "node_load1"])
        : { status: 404 };
  assert.deepEqual(await discoverMetrics(target()), [
    { name: "node_load1", type: "unknown" },
    { name: "up", type: "unknown" },
  ]);
  const fallback = fake.seen.at(-1);
  assert.ok(fallback && params(fallback).get("start") && params(fallback).get("end"));
});

test("labels are asked per picked metric, by an exact __name__ selector, without __name__", async () => {
  fake.seen.length = 0;
  fake.handle = labelsAnswer({ up: ["__name__", "job", "instance"], 'odd"name': ["x"] });
  assert.deepEqual(await discoverLabels(target(), ["up", 'odd"name', "absent"]), {
    up: ["instance", "job"],
    'odd"name': ["x"],
    absent: [],
  });
  assert.deepEqual(fake.seen.map((r) => r.form.get("match[]")).sort(), [
    '{__name__="absent"}',
    '{__name__="odd\\"name"}',
    '{__name__="up"}',
  ]);
});

test("a refresh keeps the allowlist, updates labels and types, and reports what has no series", async () => {
  fake.handle = (r) =>
    r.path === "/api/v1/metadata"
      ? success({ up: [{ type: "gauge" }], http_requests_total: [{ type: "counter" }] })
      : r.path === "/api/v1/labels"
        ? labelsAnswer({ up: ["job", "instance", "zone"], http_requests_total: [] })(r)
        : { status: 404 };
  const current = cfg([
    { name: "up", type: "unknown", labels: ["job", "instance"] },
    { name: "http_requests_total", type: "counter", labels: ["route"] },
  ]);
  const refresh = await refreshPrometheusCatalog(target(), current);
  assert.deepEqual(refresh.missingTables, ["http_requests_total"]);
  assert.deepEqual(
    refresh.config.metrics.map((m) => [m.name, m.type, m.labels]),
    [
      ["up", "gauge", ["instance", "job", "zone"]],
      ["http_requests_total", "counter", ["route"]],
    ],
  );
  const diff = diffMetricCatalog(
    { config: current, catalogMissingTables: [] },
    { config: refresh.config, missingTables: refresh.missingTables },
  );
  assert.deepEqual(diff, {
    missingMetrics: ["http_requests_total"],
    restoredMetrics: [],
    metrics: [
      {
        metric: "up",
        addedLabels: ["zone"],
        removedLabels: [],
        type: { from: "unknown", to: "gauge" },
      },
    ],
  });
  assert.equal(
    summarizeCatalogDiff(diff),
    "1 metric missing, 1 label added, 1 metric type changed.",
  );
  assert.equal(
    isUnchanged({ missingMetrics: [], restoredMetrics: [], metrics: [] }),
    true,
  );
});

test("the test splits latency, names the endpoint, reads the write surface and checks every metric", async () => {
  fake.handle = (r) => {
    if (r.path === "/-/ready") return { text: "Prometheus Server is Ready." };
    if (r.path === "/api/v1/query")
      return success({ resultType: "scalar", result: [0, "1"] });
    if (r.path === "/api/v1/status/buildinfo") return success({ version: "3.1.0" });
    if (r.path === "/api/v1/status/flags") {
      return success({
        "web.enable-admin-api": "false",
        "web.enable-remote-write-receiver": "true",
      });
    }
    if (r.path === "/api/v1/series") {
      return success(
        r.form.get("match[]") === '{__name__="up"}' ? [{ __name__: "up" }] : [],
      );
    }
    return { status: 404 };
  };
  const result = await testPrometheus(
    target(),
    cfg([{ name: "up" }, { name: "gone_total" }]),
  );
  assert.equal(result.ok, true);
  assert.ok(
    result.latency && result.latency.connectMs >= 0 && result.latency.queryMs >= 0,
  );
  assert.deepEqual(result.endpoint, { product: "Prometheus", version: "3.1.0" });
  assert.deepEqual(result.auth, { mode: "none", accepted: true });
  assert.equal(result.writeSurface?.verdict, "open");
  assert.match(
    result.writeSurface?.detail ?? "",
    /web\.enable-remote-write-receiver is on/,
  );
  assert.deepEqual(result.metrics, [
    { metric: "up", reachable: true },
    { metric: "gone_total", reachable: false, error: "no series in the last 1h" },
  ]);
  assert.equal(hasFinding(result), true);
  assert.equal(summarizeMetrics(result.metrics ?? []), "1 of 2 metrics have series");
  assert.match(writeSurfaceHeadline("open"), /accepts writes/);
  // A test never writes: nothing but reads were asked.
  assert.ok(
    fake.seen.every((r) => r.method === "GET" || /query|series|labels/.test(r.path)),
  );
});

test("flags the endpoint does not publish are unknown, and a refused credential says so", async () => {
  fake.handle = (r) => {
    if (r.path === "/api/v1/query")
      return success({ resultType: "scalar", result: [0, "1"] });
    if (r.path === "/api/v1/series") return success([{ __name__: "up" }]);
    return { status: 404, json: { status: "error", errorType: "not_found" } };
  };
  const unknown = await testPrometheus(target(), cfg([{ name: "up" }]));
  assert.equal(unknown.writeSurface?.verdict, "unknown");
  assert.equal(unknown.endpoint?.product, "a Prometheus-compatible API");
  assert.equal(hasFinding(unknown), true);

  fake.handle = () => ({
    status: 401,
    json: { status: "error", errorType: "unauthorized" },
  });
  const refused = await testPrometheus(target("bearer"), cfg([{ name: "up" }]));
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.auth, { mode: "none", accepted: false });
  assert.match(refused.message, /refused the unauthenticated request \(401\)/);
});

function record(config: PrometheusConfig, missing: string[] = []): SourceRecord {
  return {
    id: "prom",
    workspaceId: "ws",
    name: "Prom",
    kind: "prometheus",
    config,
    secretRef: null,
    catalogRefreshedAt: "2026-10-09T00:00:00Z",
    catalogMissingTables: missing,
    createdBy: "u",
    createdAt: "",
    updatedAt: "",
    tombstonedAt: null,
  };
}

test("health speaks of metrics and the endpoint for a Prometheus source", () => {
  const source = record(cfg([{ name: "up" }, { name: "gone_total" }]), ["gone_total"]);
  const health = catalogHealth(source, { now: new Date("2026-10-09T12:00:00Z") });
  assert.equal(health.state, "drifted");
  assert.equal(health.entries, "metric");
  assert.equal(health.liveTableCount, 1);
  assert.equal(
    describeCatalogHealth(source, health),
    '1 metric in "Prom" no longer exists in the endpoint (gone_total). Refresh the catalog for source prom and adjust its metrics.',
  );
  const all = record(cfg([{ name: "gone_total" }]), ["gone_total"]);
  assert.equal(catalogHealth(all).state, "empty");
});

test("the browser view lists metrics, types, help and labels, and nothing about the endpoint", () => {
  const source = record(cfg([{ name: "up", type: "gauge", labels: ["job"] }]), []);
  const view = serverKind(source).catalogView(source, catalogHealth(source), false);
  assert.deepEqual(Object.keys(view).sort(), [
    "canManage",
    "catalogHealth",
    "metrics",
    "missingMetrics",
  ]);
  assert.ok(!JSON.stringify(view).includes(fake.url));
});
