import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "@/lib/config";
import type { CatalogSubject } from "@/lib/catalog/health";
import {
  buildFileTemplates,
  FILE_TIME_RANGE,
  MAX_MEASURES,
  recognizeTable,
} from "@/lib/builtin-templates-files";
import { convertWorkbook } from "@/lib/duckdb/workbook";
import { Dashboard, PanelQuery, queryTimeField } from "@/lib/ir";
import type { CatalogTable, SqlSourceConfig, SqlSourceRecord } from "@/lib/registry";
import { defaultTimeField } from "@/lib/source-form";
import { DuckDbConfig } from "@/lib/sources/kinds/duckdb";
import { duckdbDiscovery, serverKind } from "@/lib/sources/server/registry";
import { validateSql } from "@/lib/sql/safety";
import { type Template, templatePanels } from "@/lib/templates";
import { parseRelative } from "@/lib/time-range";
import { queryOf } from "./support/panels";

/**
 * The starter dashboards for uploaded files (#606): which recognizer a
 * table's columns choose, which columns it builds from, and that every panel
 * it writes passes the guard for both SQL dialects and answers with rows from
 * the samples the app ships.
 *
 * The samples are put where a DuckDB source reads them, the workbook through
 * the upload's own conversion, and their catalog is the one discovery reads,
 * so the column types are the engine's and not a copy that could drift.
 */

const writable = config as { duckdbSourcesDir: string };
const savedDir = writable.duckdbSourcesDir;
let root = "";
let samples: CatalogTable[] = [];

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "holotable-starters-")));
  const dir = join(root, "samples");
  mkdirSync(dir);
  const shipped = join(process.cwd(), "public/samples");
  copyFileSync(
    join(shipped, "household-expenses.csv"),
    join(dir, "household_expenses.csv"),
  );
  copyFileSync(join(shipped, "workouts.jsonl"), join(dir, "workouts.jsonl"));
  await convertWorkbook({
    file: join(shipped, "home-energy.xlsx"),
    dir,
    stem: "home_energy",
    taken: new Set(["household_expenses", "workouts"]),
    limits: { maxSheets: 10, maxRows: 10_000, maxBytes: 10_000_000 },
  });
  writable.duckdbSourcesDir = root;
  // As the upload form allowlists them: every table, its time column the
  // first date or timestamp column.
  samples = (await duckdbDiscovery("samples", "ws").tables()).map((t) => {
    const timeField = defaultTimeField(t);
    return timeField ? { ...t, timeField } : t;
  });
});

after(async () => {
  await serverKind("duckdb").dispose("samples");
  writable.duckdbSourcesDir = savedDir;
  rmSync(root, { recursive: true, force: true });
});

function duckdbRecord(tables: CatalogTable[]): SqlSourceRecord {
  return {
    id: "samples",
    workspaceId: "ws",
    name: "Samples",
    kind: "duckdb",
    config: DuckDbConfig.parse({ kind: "duckdb", path: "samples", tables }),
    secretRef: null,
    catalogRefreshedAt: "2026-10-01T00:00:00Z",
    catalogMissingTables: [],
    createdBy: "u",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    tombstonedAt: null,
  };
}

function timescale(tables: CatalogTable[]): SqlSourceConfig {
  return {
    kind: "timescaledb",
    host: "timescaledb",
    port: 5432,
    database: "holotable",
    schema: "public",
    ssl: false,
    tables,
  };
}

function subject(tables: CatalogTable[], id = "files"): CatalogSubject {
  return {
    id,
    name: "Files",
    config: timescale(tables),
    catalogRefreshedAt: "2026-10-01T00:00:00Z",
    catalogMissingTables: [],
  };
}

const table = (name: string, columns: [string, string][], timeField?: string) =>
  ({
    name,
    ...(timeField ? { timeField } : {}),
    columns: columns.map(([n, type]) => ({ name: n, type })),
  }) satisfies CatalogTable;

/** The panels of every template, each with the template it came from. */
function everyPanel(templates: Template[]) {
  return templates.flatMap((template) =>
    templatePanels(template.body).map((panel) => ({ template, panel })),
  );
}

/* -------------------------------------------------------------------------- */
/* The three samples, end to end                                              */
/* -------------------------------------------------------------------------- */

test("each shipped sample is recognized as the starter it was made for", () => {
  const built = buildFileTemplates(duckdbRecord(samples));
  assert.deepEqual(
    built.map((t) => [t.id, t.name]),
    [
      [
        "builtin:samples:home_energy_electricity:measurements",
        "Daily measurements — home_energy_electricity",
      ],
      [
        "builtin:samples:home_energy_gas:measurements",
        "Daily measurements — home_energy_gas",
      ],
      ["builtin:samples:household_expenses:spending", "Spending — household_expenses"],
      ["builtin:samples:workouts:activity", "Activity log — workouts"],
    ],
  );
  for (const t of built) {
    assert.equal(t.kind, "dashboard");
    assert.equal(t.origin, "builtin");
    assert.equal(t.recognized, true);
  }
});

test("every sample starter's SQL passes the guard in the DuckDB and the TimescaleDB dialect", async () => {
  const duck = duckdbRecord(samples);
  const built = buildFileTemplates(duck);
  for (const { template, panel } of everyPanel(built)) {
    const sql = queryOf(panel).sql;
    for (const cfg of [duck.config, timescale(samples)]) {
      const check = await validateSql(sql, cfg);
      assert.ok(
        check.ok,
        `${cfg.kind}: ${template.name} / ${panel.title}: ${check.error}\n${sql}`,
      );
    }
  }
});

test("every sample starter's panel answers with rows from the uploaded file", async () => {
  const duck = duckdbRecord(samples);
  const kind = serverKind(duck);
  // The samples cover April to September 2026; the window holds all of it.
  const window = {
    from: new Date("2026-01-01T00:00:00Z"),
    to: new Date("2027-01-01T00:00:00Z"),
  };
  for (const { template, panel } of everyPanel(buildFileTemplates(duck))) {
    const query = PanelQuery.parse(queryOf(panel));
    const check = await kind.check(duck, query);
    assert.ok(check.ok, `${template.name} / ${panel.title}: ${check.error}`);
    const plan = kind.plan(duck, query, { ...window, rowFilter: null });
    const result = await kind.execute(duck, plan);
    assert.ok(
      "rows" in result && result.rows.length > 0,
      `${template.name} / ${panel.title} returned no rows`,
    );
  }
});

test("the spending starter breaks the money down by category and lists the merchants", () => {
  const [spending] = buildFileTemplates(
    duckdbRecord(samples.filter((t) => t.name === "household_expenses")),
  );
  const panels = templatePanels(spending.body);
  assert.deepEqual(
    panels.map((p) => p.id),
    ["per-week", "latest-month", "by-category", "top-merchants", "by-month"],
  );
  const sql = panels.map((p) => queryOf(p).sql).join("\n");
  assert.match(sql, /sum\(amount\)/);
  assert.match(sql, /SELECT category, sum\(amount\)/);
  assert.match(sql, /SELECT merchant, sum\(amount\)/);
  // A payment method is not the breakdown when a category is there.
  assert.doesNotMatch(sql, /payment_method/);
});

test("the activity starter derives speed from distance and duration, in km/h", () => {
  const [log] = buildFileTemplates(
    duckdbRecord(samples.filter((t) => t.name === "workouts")),
  );
  const panels = templatePanels(log.body);
  assert.deepEqual(
    panels.map((p) => p.id),
    [
      "distance-per-week",
      "duration-per-week",
      "speed",
      "heart-rate",
      "by-type",
      "recent",
    ],
  );
  const speed = panels.find((p) => p.id === "speed");
  assert.ok(speed);
  assert.match(
    queryOf(speed).sql,
    /sum\(distance_km\) \* 60\.0 \/ nullif\(sum\(duration_min\), 0\) AS speed/,
  );
  assert.deepEqual(speed.options, { decimals: 1, unit: "km/h" });
});

/* -------------------------------------------------------------------------- */
/* What every starter is, whatever the catalog                                */
/* -------------------------------------------------------------------------- */

test("every starter is a valid dashboard over its own source, windowed by the server", () => {
  const built = buildFileTemplates(duckdbRecord(samples));
  for (const template of built) {
    assert.equal(template.body.kind, "dashboard");
    if (template.body.kind !== "dashboard") continue;
    const dashboard = Dashboard.parse(template.body.dashboard);
    // A relative window the server resolves, never a timestamp.
    assert.deepEqual(dashboard.timeRange, FILE_TIME_RANGE);
    assert.ok(parseRelative(dashboard.timeRange.from));
    for (const panel of dashboard.panels) {
      const query = queryOf(panel);
      assert.equal(query.sourceId, "samples");
      // No statement filters time itself.
      assert.doesNotMatch(query.sql, /\bWHERE\b/i);
      // A time series declares the column the server filters on, and selects it.
      const field = queryTimeField(query);
      if (field) assert.match(query.sql, new RegExp(`\\b${field}\\b`));
      assert.ok(panel.layout.x + panel.layout.w <= 12, `${panel.id} overflows the grid`);
    }
  }
});

test("the same catalog always produces the same starters, and none is a panel template", () => {
  const duck = duckdbRecord(samples);
  assert.deepEqual(buildFileTemplates(duck), buildFileTemplates(duck));
  assert.deepEqual(buildFileTemplates(duck, "panel"), []);
  assert.equal(buildFileTemplates(duck, "dashboard").length, 4);
});

/* -------------------------------------------------------------------------- */
/* The recognizer rules                                                       */
/* -------------------------------------------------------------------------- */

const EXPENSES = table("expenses", [
  ["booked_on", "date"],
  ["quantity", "integer"],
  ["amount", "numeric(12,2)"],
  ["category", "text"],
]);

test("a table with no time column yields nothing", () => {
  const timeless = table("expenses", [
    ["amount", "numeric"],
    ["category", "text"],
    ["distance_km", "double precision"],
    ["duration_min", "integer"],
  ]);
  assert.equal(recognizeTable(timeless), null);
  assert.deepEqual(buildFileTemplates(subject([timeless])), []);
});

test("the declared time field is the time column, whatever its type says", () => {
  const declared = table(
    "readings",
    [
      ["taken", "bigint"],
      ["temperature", "double precision"],
      ["humidity", "double precision"],
    ],
    "taken",
  );
  const r = recognizeTable(declared);
  assert.equal(r?.starter, "measurements");
  // The time column is never a measure.
  assert.deepEqual(r?.starter === "measurements" && r.measures.map((m) => m.name), [
    "temperature",
    "humidity",
  ]);
});

test("money before measure: an amount and a category are spending, read from the money column", () => {
  const r = recognizeTable(EXPENSES);
  assert.equal(r?.starter, "spending");
  assert.equal(r?.starter === "spending" && r.money.name, "amount");
  assert.equal(r?.starter === "spending" && r.category.name, "category");
});

test("money with nothing to break it down by is a measurement: cost_usd stays a utility reading", () => {
  const energy = table("energy", [
    ["date", "DATE"],
    ["kwh", "DOUBLE"],
    ["cost_usd", "DOUBLE"],
  ]);
  assert.equal(recognizeTable(energy)?.starter, "measurements");
  // The same columns with a category beside them are spending.
  const withCategory = table("energy", [
    ...energy.columns.map((c): [string, string] => [c.name, c.type]),
    ["account", "VARCHAR"],
  ]);
  const r = recognizeTable(withCategory);
  assert.equal(r?.starter, "spending");
  assert.equal(r?.starter === "spending" && r.money.name, "cost_usd");
});

test("the distance and duration pair: one without the other is not an activity log", () => {
  const both = table("runs", [
    ["day", "date"],
    ["distance_mi", "real"],
    ["moving_seconds", "integer"],
  ]);
  const r = recognizeTable(both);
  assert.equal(r?.starter, "activity");
  assert.equal(r?.starter === "activity" && r.distance.name, "distance_mi");
  assert.equal(r?.starter === "activity" && r.duration.name, "moving_seconds");

  const distanceOnly = table("runs", [
    ["day", "date"],
    ["distance_mi", "real"],
    ["calories", "integer"],
  ]);
  assert.equal(recognizeTable(distanceOnly)?.starter, "measurements");
  const durationOnly = table("runs", [
    ["day", "date"],
    ["duration_min", "integer"],
  ]);
  assert.equal(recognizeTable(durationOnly), null);
});

test("the speed is in the units the names say, or left unitless when they do not", () => {
  const seconds = buildFileTemplates(
    subject([
      table("rides", [
        ["ts", "timestamptz"],
        ["distance_km", "double precision"],
        ["duration_seconds", "integer"],
      ]),
    ]),
  );
  const speed = (t: Template[]) => {
    const panel = templatePanels(t[0].body).find((p) => p.id === "speed");
    assert.ok(panel, "no speed panel");
    return { sql: queryOf(panel).sql, unit: (panel.options as { unit?: string }).unit };
  };
  assert.match(speed(seconds).sql, /\* 3600\.0 \//);
  assert.equal(speed(seconds).unit, "km/h");

  const unknown = buildFileTemplates(
    subject([
      table("rides", [
        ["ts", "timestamptz"],
        ["distance", "double precision"],
        ["duration", "integer"],
      ]),
    ]),
  );
  assert.doesNotMatch(speed(unknown).sql, /\.0 \//);
  assert.equal(speed(unknown).unit, undefined);
});

test("the most specific recognizer wins, and a table gets one starter", () => {
  // Distance, duration and money with a category: an activity log first.
  const all = table("trips", [
    ["date", "date"],
    ["amount", "numeric"],
    ["category", "text"],
    ["distance_km", "double precision"],
    ["duration_min", "integer"],
  ]);
  assert.equal(recognizeTable(all)?.starter, "activity");
  // Money with a category and other numbers: spending over measurements.
  const spendingAndMore = table("orders", [
    ["date", "date"],
    ["quantity", "integer"],
    ["weight_kg", "double precision"],
    ["price", "numeric"],
    ["vendor", "text"],
  ]);
  const r = recognizeTable(spendingAndMore);
  assert.equal(r?.starter, "spending");
  // A vendor alone is both the breakdown and the only text: no second table.
  assert.equal(r?.starter === "spending" && r.category.name, "vendor");
  assert.equal(r?.starter === "spending" && r.merchant, undefined);
  assert.equal(buildFileTemplates(subject([all, spendingAndMore])).length, 2);
});

test("the measure cap: at most a fixed number of measures, keys and calendar parts never", () => {
  const wide = table("weather", [
    ["observed_at", "timestamp"],
    ["station_id", "integer"],
    ["year", "integer"],
    ["temp_c", "double precision"],
    ["humidity", "double precision"],
    ["pressure", "double precision"],
    ["wind_kph", "double precision"],
    ["rain_mm", "double precision"],
    ["kwh_per_day", "double precision"],
  ]);
  const r = recognizeTable(wide);
  assert.equal(r?.starter, "measurements");
  assert.deepEqual(
    r?.starter === "measurements" && r.measures.map((m) => m.name),
    ["temp_c", "humidity", "pressure", "wind_kph"].slice(0, MAX_MEASURES),
  );
  const [template] = buildFileTemplates(subject([wide]));
  // A stat and a series per measure, and the table of latest rows.
  assert.equal(templatePanels(template.body).length, MAX_MEASURES * 2 + 1);
  // One number is not a set of measurements.
  assert.equal(
    recognizeTable(
      table("weight", [
        ["date", "date"],
        ["kg", "double precision"],
      ]),
    ),
    null,
  );
});

test("a TimescaleDB catalog's spellings are recognized the same, and its SQL passes the guard", async () => {
  const tables = [
    EXPENSES,
    table("workouts", [
      ["started", "timestamp with time zone"],
      ["sport", "character varying(32)"],
      ["distance_km", "numeric"],
      ["duration_min", "smallint"],
    ]),
  ];
  const built = buildFileTemplates(subject(tables));
  assert.deepEqual(
    built.map((t) => t.name),
    ["Spending — expenses", "Activity log — workouts"],
  );
  for (const { template, panel } of everyPanel(built)) {
    const check = await validateSql(queryOf(panel).sql, timescale(tables));
    assert.ok(check.ok, `${template.name} / ${panel.title}: ${check.error}`);
  }
});

test("a name that is not a plain identifier is skipped, never escaped", () => {
  const hostileTable = table('spend"; DROP TABLE x; --', [
    ["date", "date"],
    ["amount", "numeric"],
    ["category", "text"],
  ]);
  assert.deepEqual(buildFileTemplates(subject([hostileTable])), []);
  const hostileColumn = table("spend", [
    ["date", "date"],
    ["amount) FROM x --", "numeric"],
    ["category", "text"],
  ]);
  assert.equal(recognizeTable(hostileColumn), null);
});

test("a table the last refresh could not find, or a hidden column, is not built on", () => {
  const missing: CatalogSubject = {
    ...subject([EXPENSES]),
    catalogMissingTables: ["expenses"],
  };
  assert.deepEqual(buildFileTemplates(missing), []);
  const hidden: CatalogTable = {
    ...EXPENSES,
    columns: EXPENSES.columns.map((c) =>
      c.name === "category" ? { ...c, exposed: false } : c,
    ),
  };
  // Without its category the money is a measure beside the quantity.
  const [template] = buildFileTemplates(subject([hidden]));
  assert.equal(template.id, "builtin:files:expenses:measurements");
  assert.doesNotMatch(JSON.stringify(template.body), /category/);
});
