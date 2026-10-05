import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBuiltinTemplates } from "@/lib/builtin-templates";
import { exposedCatalogTables } from "@/lib/catalog/health";
import { panelStarter } from "@/lib/panel-starter";
import { buildSourceDescriptionStarters, buildStarters } from "@/lib/prompts/starters";
import {
  exposedTable,
  SourceConfig,
  type SourceRecord,
  sourceCatalog,
} from "@/lib/registry";
import { catalogCompletions } from "@/lib/sql/completion";
import { validateSql } from "@/lib/sql/safety";
import { templatePanels } from "@/lib/templates";
import { buildCatalogPrompt, refreshedColumns } from "@/lib/timescaledb/catalog";
import { queryOf } from "./support/panels";

/**
 * The catalog half of per-column exposure (#12): a column marked
 * `exposed: false` is never described — not to the model, not to the editor,
 * not in a suggestion — and a refresh never quietly re-exposes it. The guard
 * half is `test/sql-safety-columns.test.ts`.
 *
 * The hidden names are distinctive so a substring search over any rendered
 * output is a fair test of "does not appear".
 */

const HIDDEN = ["secret_email", "secret_latency_ms", "secret_status", "secret_seen_at"];

const config = SourceConfig.parse({
  host: "postgres",
  port: 5432,
  database: "holotable",
  schema: "metrics",
  ssl: false,
  tables: [
    {
      name: "requests",
      // The declared time column is itself hidden; nothing may offer it.
      timeField: "secret_seen_at",
      columns: [
        { name: "secret_seen_at", type: "timestamp with time zone", exposed: false },
        { name: "ts", type: "timestamp with time zone" },
        { name: "route", type: "text" },
        { name: "duration_ms", type: "double precision" },
        { name: "secret_email", type: "text", exposed: false, description: "PII" },
        { name: "secret_latency_ms", type: "double precision", exposed: false },
        { name: "secret_status", type: "smallint", exposed: false },
      ],
    },
  ],
});

const source: SourceRecord = {
  id: "src-requests",
  workspaceId: "ws-1",
  name: "Requests",
  kind: "timescaledb",
  config,
  secretRef: "TS_SRC_REQUESTS",
  catalogRefreshedAt: new Date().toISOString(),
  catalogMissingTables: [],
  createdBy: "user-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  tombstonedAt: null,
};

function assertNoHidden(text: string, where: string): void {
  for (const name of HIDDEN) {
    assert.equal(text.includes(name), false, `${where} mentions ${name}`);
  }
}

test("a stored config without the flag stays valid, and the flag must be a boolean", () => {
  const legacy = SourceConfig.safeParse({
    ...config,
    tables: [{ name: "t", columns: [{ name: "c", type: "text" }] }],
  });
  assert.equal(legacy.success, true);
  assert.equal(legacy.data?.tables[0].columns[0].exposed, undefined);

  const wrong = SourceConfig.safeParse({
    ...config,
    tables: [{ name: "t", columns: [{ name: "c", type: "text", exposed: "no" }] }],
  });
  assert.equal(wrong.success, false);
});

test("an unexposed column does not appear in the catalog prompt", () => {
  const prompt = buildCatalogPrompt(source);
  assertNoHidden(prompt, "the catalog prompt");
  for (const name of ["ts", "route", "duration_ms"]) {
    assert.match(prompt, new RegExp(`^    ${name} `, "m"), `prompt lists ${name}`);
  }
  // The declared time column is hidden, so the prompt names no time column
  // rather than one the guard would refuse.
  assert.doesNotMatch(prompt, /time column:/);
});

test("the projection a browser receives carries no unexposed column", () => {
  const catalog = sourceCatalog(config);
  assertNoHidden(JSON.stringify(catalog), "the client catalog");
  assertNoHidden(JSON.stringify(catalogCompletions(catalog)), "editor completions");
  assert.equal(catalog.tables[0].timeField, undefined);
});

test("a table with nothing hidden is passed through untouched", () => {
  const table = { name: "t", timeField: "ts", columns: [{ name: "ts", type: "date" }] };
  assert.equal(exposedTable(table), table);
});

test("suggestions are built from exposed columns only, and the guard accepts every one", async () => {
  assertNoHidden(buildStarters(source, "panel").join("\n"), "panel starters");
  assertNoHidden(buildStarters(source, "dashboard").join("\n"), "dashboard starters");
  assertNoHidden(buildSourceDescriptionStarters([source]).join("\n"), "source starters");

  const starter = panelStarter(sourceCatalog(config));
  assertNoHidden(starter.sql, "the new-panel starter");
  assert.equal((await validateSql(starter.sql, config)).ok, true, starter.sql);

  const templates = buildBuiltinTemplates(source);
  assert.ok(templates.length > 0, "the exposed columns still support some template");
  assertNoHidden(JSON.stringify(templates), "built-in templates");
  for (const template of templates) {
    for (const panel of templatePanels(template.body)) {
      const result = await validateSql(queryOf(panel).sql, config);
      assert.equal(result.ok, true, `${panel.query?.sql} -> ${result.error}`);
    }
  }
});

test("exposedCatalogTables still drops a table the last refresh could not find", () => {
  const drifted = { ...source, catalogMissingTables: ["requests"] };
  assert.deepEqual(exposedCatalogTables(drifted), []);
});

test("a refresh round-trips exposed: false, and a new column starts exposed", () => {
  const existing = config.tables[0].columns;
  const columns = refreshedColumns(existing, [
    { column_name: "ts", data_type: "timestamp with time zone" },
    // Retyped since the last refresh: the database's type wins, the flag stays.
    { column_name: "secret_email", data_type: "character varying" },
    { column_name: "secret_status", data_type: "smallint" },
    // New in the database.
    { column_name: "region", data_type: "text" },
  ]);

  assert.deepEqual(columns, [
    { name: "ts", type: "timestamp with time zone" },
    {
      name: "secret_email",
      type: "character varying",
      description: "PII",
      exposed: false,
    },
    { name: "secret_status", type: "smallint", exposed: false },
    { name: "region", type: "text" },
  ]);
});

test("a refresh keeps an explicit exposed: true as written", () => {
  const columns = refreshedColumns(
    [{ name: "route", type: "text", exposed: true }],
    [{ column_name: "route", data_type: "text" }],
  );
  assert.deepEqual(columns, [{ name: "route", type: "text", exposed: true }]);
});
