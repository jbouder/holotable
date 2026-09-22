import { test } from "node:test";
import assert from "node:assert/strict";
import {
  catalogHealth,
  catalogHealthLabel,
  catalogRefusal,
  describeCatalogHealth,
  liveCatalogTables,
} from "@/lib/catalog/health";
import { SourceConfig, type SourceRecord } from "@/lib/registry";
import { renderCatalog } from "@/lib/timescaledb/catalog";

/**
 * A catalog is the only thing standing between a plain-English request and
 * SQL against columns that do not exist. These tests pin which states refuse
 * generation, which merely warn, and that a table the database no longer has
 * stops reaching the prompt.
 */

const NOW = new Date("2026-09-22T12:00:00.000Z");

function source(patch: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: "ts-metrics",
    workspaceId: "demo",
    name: "Metrics",
    kind: "timescaledb",
    config: SourceConfig.parse({
      host: "db.internal",
      port: 5432,
      database: "holotable",
      schema: "metrics",
      ssl: false,
      tables: [
        { name: "http_requests", columns: [{ name: "ts", type: "timestamptz" }] },
        { name: "cpu_usage", columns: [{ name: "ts", type: "timestamptz" }] },
      ],
    }),
    secretRef: "TS_METRICS",
    catalogRefreshedAt: "2026-09-22T11:00:00.000Z",
    catalogMissingTables: [],
    createdBy: "u1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tombstonedAt: null,
    ...patch,
  };
}

const health = (s: SourceRecord, staleAfterDays = 30) =>
  catalogHealth(s, { now: NOW, staleAfterDays });

test("a freshly refreshed catalog is ok and does not block", () => {
  const h = health(source());
  assert.equal(h.state, "ok");
  assert.equal(h.blocked, false);
  assert.equal(h.ageDays, 0);
  assert.equal(h.liveTableCount, 2);
});

test("a catalog that has never been refreshed blocks generation", () => {
  const s = source({ catalogRefreshedAt: null });
  const h = health(s);
  assert.equal(h.state, "never_refreshed");
  assert.equal(h.blocked, true);
  assert.equal(h.ageDays, null);

  const refusal = catalogRefusal(s, h);
  assert.ok(refusal);
  // The refusal names the source and the fix — both, in that order.
  assert.match(refusal, /"Metrics"/);
  assert.match(refusal, /Refresh the catalog for source ts-metrics/);
});

test("an unparseable refresh timestamp reads as never refreshed", () => {
  assert.equal(
    health(source({ catalogRefreshedAt: "not a date" })).state,
    "never_refreshed",
  );
});

test("a catalog whose every table has gone is empty, and blocks", () => {
  const s = source({ catalogMissingTables: ["http_requests", "cpu_usage"] });
  const h = health(s);
  assert.equal(h.state, "empty");
  assert.equal(h.blocked, true);
  assert.equal(h.liveTableCount, 0);
  assert.match(String(catalogRefusal(s, h)), /Refresh the catalog for source ts-metrics/);
});

test("a missing table warns rather than blocking while others survive", () => {
  const s = source({ catalogMissingTables: ["cpu_usage"] });
  const h = health(s);
  assert.equal(h.state, "drifted");
  assert.equal(h.blocked, false);
  assert.equal(h.liveTableCount, 1);
  assert.equal(catalogRefusal(s, h), null);
  assert.equal(catalogHealthLabel(h), "1 table missing");
  assert.match(
    describeCatalogHealth(s, h),
    /no longer exists in the database \(cpu_usage\)/,
  );
});

test("an old catalog is stale, which warns but never blocks", () => {
  const s = source({ catalogRefreshedAt: "2026-07-01T12:00:00.000Z" });
  const h = health(s);
  assert.equal(h.state, "stale");
  assert.equal(h.blocked, false);
  assert.equal(h.ageDays, 83);
  assert.equal(catalogRefusal(s, h), null);
  assert.match(describeCatalogHealth(s, h), /83 days ago/);
});

test("staleAfterDays 0 disables the age check", () => {
  const s = source({ catalogRefreshedAt: "2020-01-01T00:00:00.000Z" });
  assert.equal(catalogHealth(s, { now: NOW, staleAfterDays: 0 }).state, "ok");
});

test("drift outranks staleness: the gone table is the more useful thing to say", () => {
  const s = source({
    catalogRefreshedAt: "2026-07-01T12:00:00.000Z",
    catalogMissingTables: ["cpu_usage"],
  });
  assert.equal(health(s).state, "drifted");
});

test("missing tables are excluded from the live set the prompt is built from", () => {
  const s = source({ catalogMissingTables: ["cpu_usage"] });
  assert.deepEqual(
    liveCatalogTables(s).map((t) => t.name),
    ["http_requests"],
  );
  // The allowlist itself is untouched: a refresh reports drift, it does not
  // edit what the author chose.
  assert.equal(s.config.tables.length, 2);
});

test("a missing table's stale columns never reach the prompt", () => {
  const before = renderCatalog(source());
  assert.match(before, /- cpu_usage/);

  const after = renderCatalog(source({ catalogMissingTables: ["cpu_usage"] }));
  assert.doesNotMatch(after, /cpu_usage/);
  assert.match(after, /- http_requests/);
});
