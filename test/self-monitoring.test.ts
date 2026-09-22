import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  PANEL_METRIC_FAMILIES,
  SELF_METRICS_TABLE,
  SELF_SOURCE_ID,
  selfMonitoringConfig,
  selfMonitoringSpec,
  selfMonitoringTables,
} from "@/lib/self-monitoring/dashboard";
import {
  COLLECTED_FAMILIES,
  canonicalLabels,
  isCollected,
  metricFamily,
  parseExposition,
  PROMOTED_LABELS,
  ROW_COLUMNS,
  rowValues,
  toRow,
} from "@/lib/self-monitoring/exposition";
import { SourceConfig } from "@/lib/registry";
import { buildExecutablePlan, validateSql } from "@/lib/sql/safety";
import { resolveTimeRange } from "@/lib/time";

/**
 * A real scrape of the compose stack's `/api/metrics`, idle. Everything the
 * app can export declares a `# TYPE` here even when it has no series yet,
 * which makes it the oracle for "is this metric name real".
 */
const SCRAPE = readFileSync(
  new URL("./fixtures/metrics-scrape.txt", import.meta.url),
  "utf8",
);

const connection = {
  host: "postgres",
  port: 5432,
  database: "holotable",
  schema: "metrics",
  ssl: false,
};

// --- the exposition parser --------------------------------------------------

test("parses a bare sample", () => {
  assert.deepEqual(parseExposition("holotable_pollers_active 3"), [
    { name: "holotable_pollers_active", labels: {}, value: 3 },
  ]);
});

test("skips HELP, TYPE, comments and blank lines", () => {
  const body = [
    "# HELP holotable_pollers_active Dashboard pollers.",
    "# TYPE holotable_pollers_active gauge",
    "",
    "   ",
    "holotable_pollers_active 1",
  ].join("\n");
  assert.deepEqual(
    parseExposition(body).map((s) => s.name),
    ["holotable_pollers_active"],
  );
});

test("parses labels, including a comma and an escaped quote inside a value", () => {
  const [sample] = parseExposition(
    'holotable_llm_tokens_total{workspace="a,b",model="gpt\\"4",direction="input"} 12',
  );
  assert.deepEqual(sample.labels, {
    workspace: "a,b",
    model: 'gpt"4',
    direction: "input",
  });
  assert.equal(sample.value, 12);
});

test("unescapes a newline in a label value", () => {
  const [sample] = parseExposition('a_metric{help="one\\ntwo"} 1');
  assert.equal(sample.labels.help, "one\ntwo");
});

test("reads +Inf, -Inf and NaN", () => {
  const samples = parseExposition(
    ['a_bucket{le="+Inf"} 5', "b_metric -Inf", "c_metric NaN"].join("\n"),
  );
  assert.equal(samples[0].value, 5);
  assert.equal(samples[1].value, Number.NEGATIVE_INFINITY);
  assert.ok(Number.isNaN(samples[2].value));
});

test("ignores the exposition's own trailing timestamp", () => {
  const [sample] = parseExposition("a_metric 7 1395066363000");
  assert.equal(sample.value, 7);
});

test("skips a malformed line instead of failing the whole scrape", () => {
  const body = ['{no_name="x"} 1', 'a_metric{unterminated="x 2', "b_metric 3"].join("\n");
  assert.deepEqual(
    parseExposition(body).map((s) => s.name),
    ["b_metric"],
  );
});

test("metricFamily strips only the histogram suffixes", () => {
  assert.equal(
    metricFamily("holotable_query_duration_seconds_bucket"),
    "holotable_query_duration_seconds",
  );
  assert.equal(
    metricFamily("holotable_query_duration_seconds_sum"),
    "holotable_query_duration_seconds",
  );
  assert.equal(
    metricFamily("holotable_query_duration_seconds_count"),
    "holotable_query_duration_seconds",
  );
  assert.equal(metricFamily("holotable_llm_tokens_total"), "holotable_llm_tokens_total");
});

test("only allowlisted families are collected", () => {
  assert.equal(
    isCollected({ name: "holotable_pollers_active", labels: {}, value: 1 }),
    true,
  );
  assert.equal(
    isCollected({
      name: "holotable_query_duration_seconds_bucket",
      labels: {},
      value: 1,
    }),
    true,
  );
  assert.equal(
    isCollected({ name: "holotable_nodejs_version_info", labels: {}, value: 1 }),
    false,
  );
});

test("canonicalLabels is sorted, so a scrape's label order cannot change the row", () => {
  assert.equal(
    canonicalLabels({ model: "m", workspace: "w", direction: "input" }),
    canonicalLabels({ workspace: "w", direction: "input", model: "m" }),
  );
  assert.equal(canonicalLabels({ b: "2", a: "1" }), 'a="1",b="2"');
  assert.equal(canonicalLabels({}), "");
});

test("toRow promotes the instruments' labels to columns and keeps the rest", () => {
  const row = toRow({
    name: "holotable_llm_tokens_total",
    labels: { workspace: "demo", model: "gpt", direction: "output", stray: "kept" },
    value: 42,
  });
  assert.equal(row.workspace, "demo");
  assert.equal(row.model, "gpt");
  assert.equal(row.direction, "output");
  assert.equal(row.source, null);
  assert.equal(row.value, 42);
  assert.match(row.labels, /stray="kept"/);
});

test("le is the bucket bound, and NULL for +Inf and for anything that is not a bucket", () => {
  const bucket = toRow({
    name: "holotable_poller_tick_duration_seconds_bucket",
    labels: { le: "0.25", dashboard: "d1" },
    value: 9,
  });
  assert.equal(bucket.le, 0.25);
  assert.equal(bucket.dashboard, "d1");

  const infinite = toRow({
    name: "holotable_poller_tick_duration_seconds_bucket",
    labels: { le: "+Inf" },
    value: 9,
  });
  assert.equal(infinite.le, null);

  const gauge = toRow({ name: "holotable_pollers_active", labels: {}, value: 2 });
  assert.equal(gauge.le, null);
});

test("rowValues follows ROW_COLUMNS, which is what the INSERT binds", () => {
  const row = toRow({ name: "holotable_pollers_active", labels: {}, value: 2 });
  const values = rowValues(row);
  assert.equal(values.length, ROW_COLUMNS.length);
  assert.equal(values[ROW_COLUMNS.indexOf("metric")], "holotable_pollers_active");
  assert.equal(values[ROW_COLUMNS.indexOf("value")], 2);
});

// --- the committed dashboard ------------------------------------------------

test("the committed spec parses against the current IR", () => {
  const spec = selfMonitoringSpec();
  assert.ok(spec.panels.length > 0);
  const ids = spec.panels.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("every panel reads the self source and nothing else", () => {
  for (const panel of selfMonitoringSpec().panels) {
    assert.equal(panel.query.sourceId, SELF_SOURCE_ID, panel.id);
  }
});

test("the catalog names every column the panels select on", () => {
  const [table] = selfMonitoringTables();
  assert.equal(table.name, SELF_METRICS_TABLE);
  const columns = new Set(table.columns.map((c) => c.name));
  for (const promoted of PROMOTED_LABELS) assert.ok(columns.has(promoted), promoted);
  for (const required of ["ts", "metric", "labels", "le", "value"]) {
    assert.ok(columns.has(required), required);
  }
});

test("every panel's SQL passes the guard against the committed catalog", async () => {
  const source = SourceConfig.parse(selfMonitoringConfig(connection));
  for (const panel of selfMonitoringSpec().panels) {
    const result = await validateSql(panel.query.sql, source);
    assert.equal(result.ok, true, `${panel.id}: ${result.ok ? "" : result.error}`);
  }
});

test("every panel builds an executable plan with the server's time range", () => {
  const spec = selfMonitoringSpec();
  const range = resolveTimeRange(spec.timeRange);
  for (const panel of spec.panels) {
    const plan = buildExecutablePlan({
      sql: panel.query.sql,
      timeField: panel.query.timeField,
      from: range.from,
      to: range.to,
    });
    assert.match(plan.sql, /LIMIT \d+$/);
    // A panel that declares a time field is filtered by the server, never by
    // the SQL: two bound parameters, and no time expression in the spec.
    assert.equal(plan.params.length, panel.query.timeField ? 2 : 0, panel.id);
  }
});

/**
 * The panels and the collector's allowlist are one contract: a panel written
 * against a metric nothing collects renders an empty chart forever, and a
 * family collected for no panel is rows nobody reads.
 */
test("the panels and the collector agree on which metrics exist", () => {
  const referenced = new Set<string>();
  for (const panel of selfMonitoringSpec().panels) {
    for (const match of panel.query.sql.matchAll(/'(holotable_[a-z0-9_]+)'/g)) {
      referenced.add(metricFamily(match[1]));
    }
  }
  assert.deepEqual([...referenced].sort(), [...PANEL_METRIC_FAMILIES].sort());
  for (const family of referenced) {
    assert.ok(COLLECTED_FAMILIES.has(family), `${family} is queried but never collected`);
  }
});

/**
 * Invariant 5: a spec references a source by id and carries nothing else about
 * it. The demo spec ships in the repository, so this is also the test that it
 * never picks up a host or a credential on the way in.
 */
test("the committed spec carries no connection detail", () => {
  const serialized = JSON.stringify(selfMonitoringSpec());
  for (const forbidden of [
    "host",
    "port",
    "password",
    "secretRef",
    "secret_ref",
    "postgres://",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

// --- the collector against a real scrape ------------------------------------

/**
 * The bug this catches: `holotable_nodejs_eventloop_lag_p95_seconds` looks
 * exactly like a metric prom-client exports, and is not one — the percentiles
 * it exposes are p50, p90 and p99. A family that is never exposed is silent:
 * nothing errors, the rows simply never arrive.
 */
test("every collected family is one the app really exports", () => {
  const exported = new Set([...SCRAPE.matchAll(/^# TYPE (\S+) /gm)].map((m) => m[1]));
  for (const family of COLLECTED_FAMILIES) {
    assert.ok(exported.has(family), `${family} is collected but never exported`);
  }
});

test("a real scrape parses, and the allowlist narrows it", () => {
  const samples = parseExposition(SCRAPE);
  assert.ok(samples.length > 50, `only parsed ${samples.length} samples`);

  const collected = samples.filter(isCollected);
  assert.ok(collected.length > 0);
  assert.ok(
    collected.length < samples.length,
    "the allowlist let everything through, which is not what it is for",
  );
  for (const sample of collected) {
    assert.ok(COLLECTED_FAMILIES.has(metricFamily(sample.name)), sample.name);
  }
});

test("a real scrape's multi-label series survive as distinct rows", () => {
  // `holotable_nodejs_version_info` carries four labels, none of them
  // promoted. Its row keeps them in `labels` rather than flattening to
  // something another series could collide with.
  const [version] = parseExposition(SCRAPE).filter(
    (s) => s.name === "holotable_nodejs_version_info",
  );
  assert.ok(version, "the fixture should contain a version_info sample");
  const row = toRow(version);
  assert.match(row.labels, /^major=/);
  assert.match(row.labels, /version="v\d+/);
  for (const promoted of PROMOTED_LABELS) assert.equal(row[promoted], null);
});
