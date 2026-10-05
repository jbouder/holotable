import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  type Dashboard as DashboardSpec,
  Dashboard,
  declaredVariables,
  hasQuery,
  PanelQuery,
  type QueryPanel,
  SPEC_VERSION,
  type Variable,
} from "@/lib/ir";
import { StoredDashboard } from "@/lib/ir/upgrade";
import { PANEL_KIND_NAMES } from "@/lib/panels/registry";
import { SourceConfig } from "@/lib/registry";
import { bindRowFilter } from "@/lib/sql/row-filter";
import { buildExecutablePlan, validateSql } from "@/lib/sql/safety";
import type { VariableValues } from "@/lib/sql/variables";
import {
  authoredVersion,
  type Catalogs,
  contentDigest,
  type Fixture,
  loadFixtureLibrary,
} from "../scripts/lib/spec-fixtures";
import { matchJsonSnapshot } from "./support/snapshot";

/*
 * The IR contract (#90): every spec in `test/fixtures/specs/` is one a
 * database somewhere may hold, so every build must still load it, its SQL
 * must still pass the guard, and the statement the server would run for it
 * must not change by accident. A breaking change to `src/lib/ir.ts` without an
 * upgrader in `src/lib/ir/upgrade.ts` fails here, against fixtures nobody is
 * allowed to edit to make it pass.
 *
 * The two snapshots under `test/snapshots/` are the review surface for the
 * rest: the JSON Schema derived from the IR, which diffs on any schema change
 * at all, and the executable plan of every fixture panel. Rewrite them with
 * `UPDATE_SNAPSHOTS=1 npm test`.
 */

const library = loadFixtureLibrary();

interface Loaded {
  file: string;
  raw: unknown;
  spec: DashboardSpec;
}

/**
 * Every fixture as it loads today. One that does not is reported by its own
 * test below; the others are still checked, so one broken fixture does not
 * hide what else a change broke.
 */
const parsed = library.fixtures.map((fixture: Fixture) => ({
  fixture,
  result: StoredDashboard.safeParse(fixture.spec),
}));
const loaded: Loaded[] = parsed.flatMap(({ fixture, result }) =>
  result.success ? [{ file: fixture.file, raw: fixture.spec, spec: result.data }] : [],
);

function sourceConfig(catalogs: Catalogs, sourceId: string, file: string): SourceConfig {
  const catalog = catalogs[sourceId];
  assert.ok(catalog, `${file} reads source "${sourceId}", which catalogs.json lacks`);
  // A catalog is the allowlist alone; the connection half is a placeholder.
  return SourceConfig.parse({
    host: "fixture",
    port: 5432,
    database: "fixture",
    ...catalog,
  });
}

/** The value a viewer gets before picking one, or a stand-in for a query variable. */
function defaultValues(variables: Variable[] | undefined): VariableValues {
  return Object.fromEntries(
    (variables ?? []).map((v) => {
      const picked = [v.default ?? v.values?.[0] ?? `${v.name}-value`].flat();
      return [v.name, v.multi ? picked : picked[0]];
    }),
  );
}

// ---------------------------------------------------------------------------
// The library itself
// ---------------------------------------------------------------------------

test("every fixture is in the manifest, unedited, at the version it was authored at", () => {
  const files = new Set(library.fixtures.map((f) => f.file));
  for (const name of Object.keys(library.manifest)) {
    assert.ok(files.has(name), `index.json lists ${name}, which does not exist`);
  }
  for (const fixture of library.fixtures) {
    const entry = library.manifest[fixture.file];
    assert.ok(
      entry,
      `${fixture.file} is not in index.json; add fixtures with npm run fixture:capture`,
    );
    assert.equal(
      contentDigest(fixture.spec),
      entry.digest,
      `${fixture.file} was edited. Fixtures are never edited in place: add a new one ` +
        `(and, for a breaking IR change, an upgrader) instead.`,
    );
    assert.equal(authoredVersion(fixture.spec), entry.authoredAt, fixture.file);
    assert.match(fixture.file, new RegExp(`^v${entry.authoredAt}-`), fixture.file);
    assert.ok(entry.authoredAt <= SPEC_VERSION, `${fixture.file} is from a newer build`);
  }
});

test("the current version has fixtures of its own", () => {
  // A version bump keeps the old fixtures and adds new ones beside them.
  assert.ok(
    Object.values(library.manifest).some((e) => e.authoredAt === SPEC_VERSION),
    `no fixture is authored at specVersion ${SPEC_VERSION}; add one when bumping it`,
  );
});

test("no catalog carries a connection or a credential", () => {
  for (const [id, catalog] of Object.entries(library.catalogs)) {
    assert.deepEqual(
      Object.keys(catalog).filter((k) => !["schema", "tables", "rowFilter"].includes(k)),
      [],
      id,
    );
  }
});

// ---------------------------------------------------------------------------
// Every fixture loads, validates and plans
// ---------------------------------------------------------------------------

for (const { fixture, result } of parsed) {
  test(`${fixture.file} loads through StoredDashboard as a current-version spec`, () => {
    assert.ok(
      result.success,
      `${fixture.file} no longer loads. Fixtures are never edited: a breaking IR change ` +
        `bumps SPEC_VERSION and adds an upgrader to src/lib/ir/upgrade.ts.\n` +
        `${result.success ? "" : result.error.message}`,
    );
    assert.equal(result.data.specVersion, SPEC_VERSION);
    // What it upgraded to is itself a valid current spec, so a save of it
    // round-trips without the chain.
    assert.deepEqual(
      Dashboard.parse(JSON.parse(JSON.stringify(result.data))),
      result.data,
    );
  });
}

test("every panel's SQL passes the guard against its fixture catalog", async () => {
  for (const { file, spec } of loaded) {
    const declared = declaredVariables(spec);
    for (const panel of spec.panels.filter(hasQuery)) {
      const cfg = sourceConfig(library.catalogs, panel.query.sourceId, file);
      const result = await validateSql(panel.query.sql, cfg, declared);
      assert.ok(result.ok, `${file} panel ${panel.id}: ${result.error}`);
    }
    for (const v of spec.variables ?? []) {
      if (!v.query) continue;
      const cfg = sourceConfig(library.catalogs, v.query.sourceId, file);
      const result = await validateSql(v.query.sql, cfg);
      assert.ok(result.ok, `${file} variable ${v.name}: ${result.error}`);
    }
  }
});

test("every panel's executable plan matches its snapshot", async () => {
  const window = {
    from: new Date("2026-01-01T00:00:00.000Z"),
    to: new Date("2026-01-01T01:00:00.000Z"),
  };
  const plans: Record<string, unknown> = {};
  for (const { file, spec } of loaded) {
    const declared = declaredVariables(spec);
    const variables = defaultValues(spec.variables);
    for (const panel of spec.panels.filter(hasQuery) as QueryPanel[]) {
      const cfg = sourceConfig(library.catalogs, panel.query.sourceId, file);
      // Loads the parser the plan builder's scanner needs.
      await validateSql(panel.query.sql, cfg, declared);
      const plan = buildExecutablePlan({
        sql: panel.query.sql,
        timeField: panel.query.timeField,
        ...window,
        rowFilter: bindRowFilter(cfg, () => "fixture-tenant"),
        variables,
      });
      plans[`${file}#${panel.id}`] = plan;
    }
  }
  matchJsonSnapshot(
    new URL("./snapshots/executable-plans.json", import.meta.url),
    plans,
    "the executable plan of a fixture panel",
  );
});

// ---------------------------------------------------------------------------
// The derived JSON Schema
// ---------------------------------------------------------------------------

const schema = z.toJSONSchema(Dashboard, { io: "input" });

/** A property's declared bounds in a derived JSON Schema. */
function bounds(
  json: { properties?: Record<string, unknown> },
  key: string,
): { maxItems?: number; maxLength?: number } {
  return (json.properties?.[key] ?? {}) as { maxItems?: number; maxLength?: number };
}

test("the JSON Schema derived from the IR matches its snapshot", () => {
  matchJsonSnapshot(
    new URL("./snapshots/ir.schema.json", import.meta.url),
    schema,
    "the dashboard IR's JSON Schema",
  );
});

// ---------------------------------------------------------------------------
// What the library covers
// ---------------------------------------------------------------------------

test("the library covers every panel kind and the shapes a spec can take", () => {
  const specs = loaded.map((l) => l.spec);
  const panels = specs.flatMap((s) => s.panels);
  const queries = panels.filter(hasQuery);

  const kinds = new Set(panels.map((p) => p.viz));
  const missing = PANEL_KIND_NAMES.filter((k) => !kinds.has(k));
  assert.deepEqual(missing, [], `no fixture has a panel of kind: ${missing.join(", ")}`);

  const has = (what: string, ok: boolean) => assert.ok(ok, `no fixture has ${what}`);
  has(
    "a panel with a timeField",
    queries.some((p) => p.query.timeField !== undefined),
  );
  has(
    "a panel without a timeField",
    queries.some((p) => p.query.timeField === undefined),
  );
  has(
    "a dashboard reading two sources",
    specs.some(
      (s) => new Set(s.panels.filter(hasQuery).map((p) => p.query.sourceId)).size > 1,
    ),
  );
  has(
    "a dashboard on one source",
    specs.some(
      (s) => new Set(s.panels.filter(hasQuery).map((p) => p.query.sourceId)).size === 1,
    ),
  );
  has(
    "an enum variable",
    specs.some((s) => s.variables?.some((v) => v.type === "enum")),
  );
  has(
    "a query variable",
    specs.some((s) => s.variables?.some((v) => v.type === "query")),
  );
  has(
    "a multi-value variable",
    specs.some((s) => s.variables?.some((v) => v.multi)),
  );
  has(
    "annotations",
    specs.some((s) => s.annotations !== undefined),
  );
  has(
    "a panel with its own time range",
    panels.some((p) => p.timeRange !== undefined),
  );
  has(
    "a panel with its own refresh",
    panels.some((p) => p.refreshIntervalMs !== undefined),
  );
  has(
    "panel options",
    panels.some((p) => p.options !== undefined),
  );
  has(
    "an absolute time range",
    specs.some((s) => !s.timeRange.from.startsWith("now")),
  );
  has(
    "a spec saved without specVersion",
    loaded.some(
      (l) =>
        authoredVersion(l.raw) === 1 &&
        (l.raw as { specVersion?: unknown }).specVersion === undefined,
    ),
  );
  has(
    "a non-ASCII title",
    panels.some((p) => /[^\x20-\x7e]/.test(p.title)),
  );

  // The limits, read off the schema so a raised one asks for a new fixture.
  const panelsMax = bounds(schema, "panels").maxItems;
  const variablesMax = bounds(schema, "variables").maxItems;
  const titleMax = bounds(schema, "title").maxLength;
  const sqlMax = bounds(z.toJSONSchema(PanelQuery), "sql").maxLength;
  for (const limit of [panelsMax, variablesMax, titleMax, sqlMax]) {
    assert.equal(
      typeof limit,
      "number",
      "a limit this test reads has moved in the schema",
    );
  }
  has(
    `the most panels (${panelsMax})`,
    specs.some((s) => s.panels.length === panelsMax),
  );
  has(
    `the most variables (${variablesMax})`,
    specs.some((s) => s.variables?.length === variablesMax),
  );
  has(
    `the longest title (${titleMax})`,
    specs.some((s) => s.title.length === titleMax),
  );
  has(
    `the longest SQL (${sqlMax})`,
    queries.some((p) => p.query.sql.length === sqlMax),
  );
});
