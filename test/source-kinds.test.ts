import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  SourceConfig,
  SourceDraft,
  type SourceRecord,
  sourceCatalog,
} from "@/lib/registry";
import { selfMonitoringConfig } from "@/lib/self-monitoring/dashboard";
import { sourceListing } from "@/lib/source-listing";
import {
  SOURCE_KIND_NAMES,
  SOURCE_KINDS,
  parseCatalogFacts,
  parseStoredSource,
  sourceKind,
} from "@/lib/sources/registry";
import { serverKind } from "@/lib/sources/server/registry";

/**
 * The source kind registry (#382): what a source may be is declared once per
 * kind, and nothing outside `src/lib/sources/` decides by comparing a kind.
 * These tests hold the code to that, and pin what each kind lets a browser
 * see of a source.
 */

const ROOT = new URL("..", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const path = join(d, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(entry)) found.push(path);
    }
  };
  walk(join(ROOT, dir));
  return found;
}

const APP_FILES = [...sourceFiles("src"), ...sourceFiles("scripts")].map((path) => ({
  path: relative(ROOT, path),
  text: readFileSync(path, "utf8"),
}));

const inSources = (path: string) => path.startsWith("src/lib/sources/");

/** A decision made by comparing a kind, rather than by asking the kind. */
const KIND_COMPARISONS: RegExp[] = [
  /case\s+["'](?:timescaledb|prometheus|loki)["']/,
  /[!=]==\s*["'](?:timescaledb|prometheus|loki)["']/,
  /["'](?:timescaledb|prometheus|loki)["']\s*[!=]==/,
  /\b(?:source|record|src|s)\.(?:config\.)?kind\s*[!=]==/,
  /[!=]==\s*(?:source|record|src|s)\.(?:config\.)?kind\b/,
];

test("no code outside src/lib/sources/ switches on a source's kind", () => {
  const offenders = APP_FILES.filter(({ path }) => !inSources(path)).flatMap(
    ({ path, text }) =>
      text
        .split("\n")
        .map((line, i) => ({ line, at: `${path}:${i + 1}` }))
        .filter(({ line }) => KIND_COMPARISONS.some((re) => re.test(line)))
        .map(({ at, line }) => `${at}: ${line.trim()}`),
  );
  assert.deepEqual(offenders, [], "ask sourceKind() or serverKind() instead");
});

/**
 * A narrowing to the TimescaleDB kind (#570): a comparison with its name, a
 * `case` on it, or a type that pins a source's or config's `kind` to it.
 */
const TIMESCALEDB_NARROWINGS: RegExp[] = [
  /case\s+["']timescaledb["']/,
  /[!=]==?\s*["']timescaledb["']/,
  /["']timescaledb["']\s*[!=]==?/,
  /\bkind:\s*["']timescaledb["']\s*[;}]/,
  /\bExtract<[^>]*["']timescaledb["']/,
];

test("outside the kind and its implementation, the SQL path asks for the language, never TimescaleDB (#570)", () => {
  // A source is SQL because its kind's language is (`isSqlSource`,
  // `SqlSourceRecord`), so a second SQL kind is a registration, not a hunt
  // through the modules that assumed the first.
  const offenders = APP_FILES.filter(
    ({ path }) => !inSources(path) && !path.startsWith("src/lib/timescaledb/"),
  ).flatMap(({ path, text }) =>
    text
      .split("\n")
      .map((line, i) => ({ line, at: `${path}:${i + 1}` }))
      .filter(({ line }) => TIMESCALEDB_NARROWINGS.some((re) => re.test(line)))
      .map(({ at, line }) => `${at}: ${line.trim()}`),
  );
  assert.deepEqual(offenders, [], 'ask sourceKind(source).language === "sql" instead');
});

test("the TimescaleDB implementation is reached only through its kind", () => {
  // `src/lib/timescaledb/` is the implementation behind the kind's server
  // half; a route that imports it by name has stepped around the registry.
  const offenders = APP_FILES.filter(
    ({ path, text }) =>
      !inSources(path) &&
      !path.startsWith("src/lib/timescaledb/") &&
      text.includes("@/lib/timescaledb/"),
  ).map(({ path }) => path);
  assert.deepEqual(offenders, []);
});

test("every registered kind has a server half of the same name", () => {
  for (const name of SOURCE_KIND_NAMES) {
    assert.equal(SOURCE_KINDS[name].kind, name);
    assert.equal(serverKind(name).kind, name);
  }
});

test("a config stored before the union reads as TimescaleDB, and says so on save", () => {
  const legacy = {
    host: "db",
    port: 5432,
    database: "holotable",
    schema: "metrics",
    ssl: false,
    tables: [{ name: "m", columns: [{ name: "v", type: "double precision" }] }],
  };
  const parsed = SourceConfig.parse(legacy);
  assert.equal(parsed.kind, "timescaledb");
  // What the repository writes back carries the discriminator.
  assert.equal(JSON.parse(JSON.stringify(parsed)).kind, "timescaledb");
  assert.equal(SourceConfig.safeParse({ ...legacy, kind: "clickhouse" }).success, false);
});

test("a stored row is refused when its kind is unknown or disagrees with its config", () => {
  const config = {
    host: "db",
    port: 5432,
    database: "holotable",
    tables: [{ name: "m", columns: [{ name: "v", type: "double precision" }] }],
  };
  assert.equal(parseStoredSource("timescaledb", config).kind, "timescaledb");
  assert.throws(
    () => parseStoredSource("clickhouse", config),
    /unknown source kind "clickhouse"/,
  );
  assert.throws(
    () => parseStoredSource("timescaledb", { ...config, kind: "prometheus" }),
    /says kind "prometheus"/,
  );
  assert.throws(
    () => sourceKind({ kind: "clickhouse" as "timescaledb" }),
    /unknown source kind/,
  );
  assert.throws(
    () => serverKind({ kind: "clickhouse" as "timescaledb" }),
    /unknown source kind/,
  );
});

test("every committed TimescaleDB catalog still parses", () => {
  const demo = JSON.parse(readFileSync(join(ROOT, "evals/catalogs/demo.json"), "utf8"));
  assert.equal(SourceConfig.parse(demo).kind, "timescaledb");
  const self = selfMonitoringConfig({
    host: "h",
    port: 5432,
    database: "d",
    schema: "metrics",
    ssl: false,
  });
  assert.equal(SourceConfig.parse(self).kind, "timescaledb");
});

function record(): SourceRecord {
  const config = SourceConfig.parse({
    host: "db.internal.example",
    port: 6543,
    database: "secret_db",
    schema: "metrics",
    ssl: true,
    rowFilter: { column: "tenant_id", claim: "tenant" },
    tables: [
      {
        name: "http_requests",
        timeField: "ts",
        columns: [
          { name: "ts", type: "timestamptz" },
          { name: "tenant_id", type: "text" },
          { name: "client_ip", type: "inet", exposed: false },
        ],
      },
    ],
  });
  return {
    id: "ts",
    workspaceId: "ws",
    name: "Metrics",
    kind: config.kind,
    config,
    secretRef: "TS_METRICS",
    catalogRefreshedAt: null,
    catalogMissingTables: [],
    createdBy: "u",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    tombstonedAt: null,
  };
}

test("a TimescaleDB listing is exactly its named fields", () => {
  const listing = sourceListing(record());
  assert.deepEqual(Object.keys(listing).sort(), [
    "engine",
    "id",
    "kind",
    "name",
    "schema",
    "tableCount",
    "tombstonedAt",
    "workspaceId",
  ]);
  const text = JSON.stringify(listing);
  for (const secret of [
    "db.internal.example",
    "6543",
    "secret_db",
    "TS_METRICS",
    "client_ip",
  ]) {
    assert.ok(!text.includes(secret), `the listing carries ${secret}`);
  }
});

test("a TimescaleDB catalog projection is the schema and the exposed columns", () => {
  const catalog = sourceCatalog(record().config);
  assert.deepEqual(Object.keys(catalog).sort(), ["schema", "tables"]);
  const text = JSON.stringify(catalog);
  for (const secret of ["db.internal.example", "secret_db", "client_ip"]) {
    assert.ok(!text.includes(secret), `the catalog carries ${secret}`);
  }
  assert.ok(!("rowFilter" in catalog));
  assert.ok(!("kind" in catalog));
});

test("catalog facts are read through the row's kind, and unknown ones read as never recorded (#557)", () => {
  assert.deepEqual(parseCatalogFacts("timescaledb", { timescaledb: "2.17.2" }), {
    timescaledb: "2.17.2",
  });
  assert.deepEqual(parseCatalogFacts("timescaledb", { timescaledb: null }), {
    timescaledb: null,
  });
  assert.equal(parseCatalogFacts("timescaledb", null), null);
  assert.equal(parseCatalogFacts("timescaledb", { timescaledb: 2 }), null);
  assert.equal(parseCatalogFacts("timescaledb", { timescaledb: null, x: 1 }), null);
  // A kind that records nothing has nothing to read.
  assert.equal(parseCatalogFacts("prometheus", { timescaledb: null }), null);
});

test("nothing a browser sends sets a source's catalog facts (#557)", () => {
  const { config } = record();
  // Not part of the config, nor of a draft: both are strict.
  assert.equal(
    SourceConfig.safeParse({ ...config, catalogFacts: { timescaledb: null } }).success,
    false,
  );
  assert.equal(
    SourceDraft.safeParse({
      id: "ts",
      name: "Metrics",
      secretRef: "TS_METRICS",
      config,
      catalogFacts: { timescaledb: null },
    }).success,
    false,
  );
  // And only the two routes that introspect the server write them, from what
  // the server read.
  const writers = APP_FILES.filter(
    ({ path, text }) =>
      path.startsWith("src/app/") && /catalogFacts|recordCatalogFacts/.test(text),
  ).map(({ path }) => path);
  assert.deepEqual(writers.sort(), [
    "src/app/api/sources/[id]/refresh/route.ts",
    "src/app/api/sources/[id]/test/route.ts",
  ]);
});

function lokiRecord(): SourceRecord {
  const config = SourceConfig.parse({
    kind: "loki",
    url: "https://logs.internal.example/tenant-7",
    auth: "bearer",
    rowFilter: { label: "tenant", claim: "tenant" },
    labels: [
      { name: "app", values: ["api"] },
      { name: "tenant", values: [] },
    ],
  });
  return { ...record(), id: "logs", kind: "loki", config, secretRef: "LOKI_PROD" };
}

test("a Loki listing and catalog name their fields, never the URL, auth or secret_ref (#562)", () => {
  const source = lokiRecord();
  const listing = sourceListing(source);
  assert.deepEqual(Object.keys(listing).sort(), [
    "id",
    "kind",
    "labelCount",
    "name",
    "tombstonedAt",
    "workspaceId",
  ]);
  assert.equal("labelCount" in listing && listing.labelCount, 2);
  const catalog = sourceKind(source).catalog(source.config);
  assert.deepEqual(catalog, {
    labels: [
      { name: "app", values: ["api"] },
      { name: "tenant", values: [] },
    ],
  });
  for (const text of [JSON.stringify(listing), JSON.stringify(catalog)]) {
    for (const secret of ["logs.internal.example", "tenant-7", "bearer", "LOKI_PROD"]) {
      assert.ok(!text.includes(secret), `it carries ${secret}`);
    }
  }
  assert.deepEqual(sourceKind(source).rowFilter(source.config), {
    target: "tenant",
    claim: "tenant",
  });
});

test("a Loki config says its kind: no default, and no URL with credentials in it (#562)", () => {
  const base = { url: "https://logs.example", auth: "none", labels: [{ name: "app" }] };
  assert.equal(SourceConfig.safeParse({ ...base, kind: "loki" }).success, true);
  assert.equal(SourceConfig.safeParse(base).success, false);
  assert.equal(
    SourceConfig.safeParse({ ...base, kind: "loki", url: "https://u:p@logs.example" })
      .success,
    false,
  );
  assert.equal(
    SourceConfig.safeParse({ ...base, kind: "loki", labels: [] }).success,
    false,
  );
  assert.equal(
    SourceConfig.safeParse({ ...base, kind: "loki", labels: [{ name: "__name__" }] })
      .success,
    false,
  );
});
