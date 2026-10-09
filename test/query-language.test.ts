import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  Dashboard,
  ExplorePanel,
  isPromqlQuery,
  isSqlQuery,
  Panel,
  PanelQuery,
  queryLanguage,
  queryStatement,
  queryText,
  queryTimeField,
  Variable,
} from "@/lib/ir";
import { panelDetails } from "@/lib/panel-details";
import { makePanelExecutor } from "@/lib/poller/registry";
import type { SourceRecord } from "@/lib/registry";
import { sharedSpec } from "@/lib/share-view";
import { cannotRun, wrongLanguage } from "@/lib/sources/registry";

/**
 * A panel's query is SQL or PromQL (#383), keyed on which of `sql` and
 * `promql` it carries. These tests hold the two branches, the helpers every
 * consumer reads a query through, and the refusal a PromQL query meets until
 * a Prometheus source exists to run it.
 */

const SQL = { sourceId: "ts", sql: "SELECT ts, v FROM m", timeField: "ts" };
const RANGE = {
  sourceId: "prom",
  promql: 'sum(rate(http_requests_total{job="api"}[5m]))',
};
const INSTANT = { ...RANGE, instant: true };

function panel(viz: string, query: unknown): unknown {
  return { id: "p", title: "P", viz, query, layout: { x: 0, y: 0, w: 6, h: 4 } };
}

test("a SQL query parses as it always has, and a PromQL one parses beside it", () => {
  assert.deepEqual(PanelQuery.parse(SQL), SQL);
  assert.deepEqual(PanelQuery.parse(RANGE), RANGE);
  assert.deepEqual(PanelQuery.parse({ ...INSTANT, minStep: "30s" }), {
    ...INSTANT,
    minStep: "30s",
  });
});

test("a query is one language or the other, never both or neither", () => {
  assert.equal(PanelQuery.safeParse({ ...SQL, promql: "up" }).success, false);
  assert.equal(PanelQuery.safeParse({ sourceId: "x" }).success, false);
  // Each branch is strict: SQL's time field is not PromQL's, nor the reverse.
  assert.equal(PanelQuery.safeParse({ ...RANGE, timeField: "time" }).success, false);
  assert.equal(PanelQuery.safeParse({ ...SQL, instant: true }).success, false);
});

test("a PromQL query is held to its limits", () => {
  assert.equal(PanelQuery.safeParse({ ...RANGE, promql: "" }).success, false);
  assert.equal(
    PanelQuery.safeParse({ ...RANGE, promql: "u".repeat(8_001) }).success,
    false,
  );
  assert.equal(
    PanelQuery.safeParse({ ...RANGE, promql: "u".repeat(8_000) }).success,
    true,
  );
  for (const good of ["15s", "1m", "500ms", "6h", "1d"]) {
    assert.equal(PanelQuery.safeParse({ ...RANGE, minStep: good }).success, true, good);
  }
  for (const bad of ["15", "1w", "now-1h", "-1m", "1.5m", "1m30s"]) {
    assert.equal(PanelQuery.safeParse({ ...RANGE, minStep: bad }).success, false, bad);
  }
});

test("a kind that needs time needs a range query, and a stat panel takes an instant one", () => {
  assert.equal(Panel.safeParse(panel("state-timeline", RANGE)).success, true);
  const instantTimeline = Panel.safeParse(panel("state-timeline", INSTANT));
  assert.equal(instantTimeline.success, false);
  assert.match(
    instantTimeline.error?.issues.map((i) => i.message).join("\n") ?? "",
    /needs a range query; remove "query.instant"/,
  );
  assert.equal(Panel.safeParse(panel("stat", INSTANT)).success, true);
  // The SQL rule is unchanged.
  const { timeField: _, ...untimed } = SQL;
  assert.match(
    Panel.safeParse(panel("state-timeline", untimed)).error?.issues[0]?.message ?? "",
    /needs "query.timeField"/,
  );
});

test("the helpers read a query without reaching for its fields", () => {
  const sql = PanelQuery.parse(SQL);
  const range = PanelQuery.parse(RANGE);
  const instant = PanelQuery.parse(INSTANT);
  assert.equal(isSqlQuery(sql) && !isPromqlQuery(sql), true);
  assert.equal(isPromqlQuery(range) && !isSqlQuery(range), true);
  assert.deepEqual([sql, range].map(queryLanguage), ["sql", "promql"]);
  assert.deepEqual([sql, range, instant].map(queryTimeField), ["ts", "time", undefined]);
  assert.deepEqual([sql, range].map(queryText), [SQL.sql, RANGE.promql]);
  assert.deepEqual(queryStatement(sql), { sql: SQL.sql });
  assert.deepEqual(queryStatement(range), { promql: RANGE.promql });
});

test("a query variable is a SELECT or the values of a label", () => {
  const base = { name: "host", type: "query" };
  const label = { sourceId: "prom", label: "instance", match: 'up{job="api"}' };
  assert.equal(
    Variable.safeParse({ ...base, query: { sourceId: "ts", sql: "SELECT h FROM m" } })
      .success,
    true,
  );
  assert.equal(Variable.safeParse({ ...base, query: label }).success, true);
  assert.equal(queryText(label), 'label_values(up{job="api"}, instance)');
  assert.equal(
    Variable.safeParse({ ...base, query: { ...label, label: "not a label" } }).success,
    false,
  );
  assert.equal(
    Variable.safeParse({ ...base, query: { ...label, sql: "SELECT 1" } }).success,
    false,
  );
});

test("generation is still asked for SQL only", () => {
  const generated = ExplorePanel.safeParse({
    ...(panel("line", RANGE) as object),
  });
  assert.equal(generated.success, false);
});

test("details and a share carry the statement by its language's name, and nothing else", () => {
  const promqlPanel = Panel.parse(panel("stat", INSTANT));
  assert.deepEqual(panelDetails(promqlPanel), {
    promql: RANGE.promql,
    sourceId: "prom",
    timeField: undefined,
    description: undefined,
  });
  const dashboard = Dashboard.parse({
    specVersion: 1,
    title: "D",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 5_000,
    panels: [promqlPanel, Panel.parse({ ...(panel("line", RANGE) as object), id: "q" })],
  });
  const shared = sharedSpec(dashboard, null);
  assert.deepEqual(
    shared.panels.map((p) => p.query),
    [
      { sourceId: "shared", promql: "(not shared)", instant: true },
      { sourceId: "shared", promql: "(not shared)" },
    ],
  );
  assert.ok(!JSON.stringify(shared).includes("http_requests_total"));
});

function timescale(): SourceRecord {
  return {
    id: "ts",
    workspaceId: "w1",
    name: "ts",
    kind: "timescaledb",
    secretRef: "TS",
    tombstonedAt: null,
    config: {
      kind: "timescaledb",
      host: "h",
      port: 5432,
      database: "d",
      schema: "public",
      ssl: false,
      tables: [{ name: "m", columns: [{ name: "v", type: "double precision" }] }],
    },
    catalogRefreshedAt: null,
    catalogMissingTables: [],
    createdBy: "u",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

test("a PromQL query against a SQL source is refused as the author's to fix", async () => {
  const source = timescale();
  const range = PanelQuery.parse({ ...RANGE, sourceId: "ts" });
  assert.equal(wrongLanguage(source, PanelQuery.parse(SQL)), null);
  assert.equal(
    wrongLanguage(source, range),
    'source "ts" answers SQL; this query is PromQL',
  );
  assert.equal(cannotRun(source, range), 'source "ts" answers SQL; this query is PromQL');

  let executed = false;
  const executor = makePanelExecutor(async () => {
    executed = true;
    return source;
  });
  const events = await executor(
    { ...(Panel.parse(panel("line", range)) as Panel), query: range } as Parameters<
      typeof executor
    >[0],
    { from: new Date(0), to: new Date(1) },
    "w1",
    {},
    {},
  );
  assert.ok(executed, "the source is still re-resolved first");
  assert.deepEqual(events, [
    {
      type: "panel-error",
      panelId: "p",
      error: 'source "ts" answers SQL; this query is PromQL',
      kind: "statement",
    },
  ]);
});

/*
 * Reading a query's fields directly. On the union a bare `query.sql` does not
 * compile, so what remains is a read behind `isSqlQuery`. A file that reads a
 * query's SQL fields outside the SQL-specific modules must narrow there, and
 * the few that read a streaming draft are named.
 */

const ROOT = new URL("..", import.meta.url).pathname;
const SQL_SPECIFIC = [
  "src/lib/sql/",
  "src/lib/sources/",
  "src/lib/ir.ts",
  "src/lib/timescaledb/",
];
/** Read a partial, still-streaming draft, or raw model output, which is not a `PanelQuery` yet. */
const DRAFT_READERS = ["src/lib/panel-diff.ts", "src/lib/ai/source-languages.ts"];

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const path = join(d, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
    }
  };
  walk(join(ROOT, dir));
  return out;
}

test("a query's SQL fields are read only behind isSqlQuery", () => {
  // `query.sql` / `query?.timeField` as code, not inside a prompt's quotes.
  const direct = /(?<![`'])\bquery\??\.(sql|timeField)\b/;
  const offenders = [...files("src"), ...files("scripts")]
    .map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, "utf8") }))
    .filter(({ path }) => !SQL_SPECIFIC.some((p) => path.startsWith(p)))
    .filter(({ path }) => !DRAFT_READERS.includes(path))
    .filter(({ text }) => text.split("\n").some((line) => direct.test(line)))
    .filter(({ text }) => !text.includes("isSqlQuery"))
    .map(({ path }) => path);
  assert.deepEqual(offenders, [], "read the query through queryText/queryTimeField");
});
