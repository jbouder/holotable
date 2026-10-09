import { test } from "node:test";
import assert from "node:assert/strict";
import "./support/prometheus-env";
import { PanelQuery } from "@/lib/ir";
import { buildPromqlPlanView } from "@/lib/query-plan";
import {
  SourceConfig,
  type SourceRecord,
  SourceDraft,
  sourceCatalog,
} from "@/lib/registry";
import { sourceListing } from "@/lib/source-listing";
import { MAX_METRICS } from "@/lib/sources/kinds/prometheus";
import { serverKind } from "@/lib/sources/server/registry";

/**
 * A Prometheus source (#385): what its config may hold, when it names a
 * `secret_ref`, what a browser may see of it, and the URL check run when it
 * is saved.
 */

const METRICS = [
  { name: "http_requests_total", type: "counter", labels: ["job", "tenant"] },
  { name: "up", type: "gauge", labels: ["job", "instance", "tenant"] },
];

function config(overrides: Record<string, unknown> = {}) {
  return {
    kind: "prometheus",
    url: "https://prom.example.com/select/0/prometheus",
    auth: "bearer",
    metrics: METRICS,
    ...overrides,
  };
}

test("a Prometheus config is an http(s) URL with no credentials, an auth mode and a metric allowlist", () => {
  assert.equal(SourceConfig.safeParse(config()).success, true);
  for (const url of [
    "https://user:pw@prom.example.com",
    "https://prom.example.com/?x=1",
    "https://prom.example.com/#frag",
    "ftp://prom.example.com",
    "not a url",
  ]) {
    assert.equal(SourceConfig.safeParse(config({ url })).success, false, url);
  }
  assert.equal(SourceConfig.safeParse(config({ auth: "oauth" })).success, false);
  assert.equal(SourceConfig.safeParse(config({ metrics: [] })).success, false);
  const many = Array.from({ length: MAX_METRICS + 1 }, (_, i) => ({ name: `m${i}` }));
  assert.equal(SourceConfig.safeParse(config({ metrics: many })).success, false);
  assert.equal(
    SourceConfig.safeParse(config({ metrics: [{ name: 'bad"name' }] })).success,
    false,
  );
  // A config with no `kind` is still read as TimescaleDB, never as this.
  const { kind: _, ...unkinded } = config();
  assert.equal(SourceConfig.safeParse(unkinded).success, false);
  assert.equal(
    SourceConfig.safeParse(config({ rowFilter: { label: "__name__", claim: "sub" } }))
      .success,
    false,
  );
});

test("a secret_ref is required exactly when the source needs credentials", () => {
  const draft = (cfg: Record<string, unknown>, secretRef?: string) =>
    SourceDraft.safeParse({
      id: "prom",
      name: "Prom",
      config: cfg,
      ...(secretRef ? { secretRef } : {}),
    });
  assert.equal(draft(config(), "PROM_TEST").success, true);
  assert.equal(draft(config()).success, false);
  assert.equal(draft(config({ auth: "none" })).success, true);
  assert.equal(draft(config({ auth: "none" }), "PROM_TEST").success, false);
  // SQL always needs one.
  const sql = {
    host: "db",
    port: 5432,
    database: "d",
    tables: [{ name: "t", columns: [{ name: "c", type: "text" }] }],
  };
  assert.equal(draft(sql).success, false);
  assert.equal(draft(sql, "TS").success, true);
});

function record(): SourceRecord {
  const cfg = SourceConfig.parse(
    config({ auth: "basic", rowFilter: { label: "tenant", claim: "sub" } }),
  );
  return {
    id: "prom",
    workspaceId: "ws",
    name: "Prometheus",
    kind: "prometheus",
    config: cfg,
    secretRef: "PROM_TEST",
    catalogRefreshedAt: null,
    catalogMissingTables: [],
    createdBy: "u",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    tombstonedAt: null,
  };
}

test("the listing and the editor's catalog never carry the URL, the auth mode or the reference", () => {
  const listing = sourceListing(record());
  assert.deepEqual(Object.keys(listing).sort(), [
    "id",
    "kind",
    "metricCount",
    "name",
    "tombstonedAt",
    "workspaceId",
  ]);
  const catalog = sourceCatalog(record().config);
  assert.deepEqual(Object.keys(catalog), ["metrics"]);
  for (const view of [listing, catalog]) {
    const text = JSON.stringify(view);
    for (const secret of ["prom.example.com", "basic", "PROM_TEST", "select/0"]) {
      assert.ok(!text.includes(secret), `${secret} leaked`);
    }
  }
});

test("a source URL is checked against SOURCE_URL_ALLOWLIST when it is saved", async () => {
  const check = (url: string) =>
    serverKind("prometheus").checkConfig(SourceConfig.parse(config({ url })));
  assert.equal(await check("http://127.0.0.1:9090"), null); // allowlisted by the test env
  assert.match(
    (await check("http://10.0.0.5:9090")) ?? "",
    /must use https\. Plain http is allowed only for a host in SOURCE_URL_ALLOWLIST/,
  );
  assert.match(
    (await check("https://10.0.0.5:9090")) ?? "",
    /not a public address\. Ask an operator to add it to SOURCE_URL_ALLOWLIST/,
  );
  assert.match((await check("https://169.254.169.254")) ?? "", /SOURCE_URL_ALLOWLIST/);
  assert.equal(await check("https://93.184.216.34"), null);
});

test("a tenant label must be a label of every metric", () => {
  const kind = serverKind("prometheus");
  assert.equal(kind.rowFilterProblem(record().config), null);
  const cfg = SourceConfig.parse(
    config({
      metrics: [...METRICS, { name: "node_load1", labels: ["instance"] }],
      rowFilter: { label: "tenant", claim: "sub" },
    }),
  );
  assert.equal(
    kind.rowFilterProblem(cfg),
    'the tenant label "tenant" must be a label of every metric; node_load1 does not list it',
  );
});

test("the PromQL plan view is an explicit field list, with where each parameter came from", () => {
  const view = buildPromqlPlanView({
    promql: "up",
    minStep: "30s",
    timeRange: { from: "now-1h", to: "now" },
    plan: {
      instant: false,
      expr: 'up{tenant="acme"}',
      start: new Date("2026-10-09T11:00:00Z"),
      end: new Date("2026-10-09T12:00:00Z"),
      stepSeconds: 30,
      timeoutMs: 20_000,
    },
    rowFilterClaim: "sub",
    limits: { maxResultBytes: 1024, maxSeries: 100 },
  });
  assert.deepEqual(Object.keys(view).sort(), [
    "endpoint",
    "executedPromql",
    "maxResultBytes",
    "maxSeries",
    "params",
    "promql",
    "timeoutMs",
  ]);
  assert.deepEqual(
    view.params.map((p) => [p.name, p.value, p.from]),
    [
      ["start", "2026-10-09T11:00:00.000Z", "now-1h, aligned to the step"],
      ["end", "2026-10-09T12:00:00.000Z", "now, aligned to the step"],
      ["step", "30s", "the window, at least the panel's minStep of 30s"],
      ["tenant", "(your value)", 'your "sub" claim'],
    ],
  );
  // The value of the tenant claim is never echoed into the view.
  assert.ok(!JSON.stringify(view.params).includes("acme"));
});

test("a PromQL panel against a SQL source is refused by name at check", async () => {
  const sql = {
    id: "ts",
    workspaceId: "ws",
    name: "TS",
    kind: "timescaledb" as const,
    config: SourceConfig.parse({
      host: "db",
      port: 5432,
      database: "d",
      tables: [{ name: "t", columns: [{ name: "c", type: "text" }] }],
    }),
    secretRef: "TS",
    catalogRefreshedAt: null,
    catalogMissingTables: [],
    createdBy: "u",
    createdAt: "",
    updatedAt: "",
    tombstonedAt: null,
  };
  assert.deepEqual(
    await serverKind(sql).check(sql, PanelQuery.parse({ sourceId: "ts", promql: "up" })),
    { ok: false, error: 'source "ts" answers SQL; this query is PromQL' },
  );
});
