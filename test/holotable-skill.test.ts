import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DashboardExportFile } from "@/lib/dashboard-export";
import {
  Dashboard,
  declaredVariables,
  hasQuery,
  Panel,
  SPEC_VERSION,
  ValueFormat,
  queryText,
  queryTimeField,
  SqlQuery,
  PromqlQuery,
  LabelValuesQuery,
  isSqlQuery,
} from "@/lib/ir";
import { validatePromql, validatePromqlLabelValues } from "@/lib/promql/safety";
import { PrometheusMetric } from "@/lib/sources/kinds/prometheus";
import { COLOR_TOKENS } from "@/lib/panels/colors";
import { PANEL_KIND_NAMES, PANEL_KINDS } from "@/lib/panels/registry";
import { CatalogTable, type SqlSourceConfig, TimescaleDbConfig } from "@/lib/registry";
import { checkSql } from "@/lib/sql/safety";

/*
 * The /holotable Claude Code skill (#147) teaches people and Claude to write
 * specs by hand. Everything it shows has to be true of this build, so every
 * example spec is parsed with the real IR, every query in it and every SQL
 * example goes through the real guard, and the lists the reference spells out
 * (panel kinds, formats, colors) are held to the code they describe.
 */

const SKILL = join(process.cwd(), ".claude/skills/holotable");
const EXAMPLES = join(SKILL, "examples");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function read(path: string): string {
  return readFileSync(join(SKILL, path), "utf8");
}

/** The example catalog, as the guard needs it. */
function exampleSource(): { sourceId: string; config: SqlSourceConfig } {
  const catalog = readJson(join(EXAMPLES, "catalog.json")) as {
    sourceId: string;
    schema: string;
    tables: unknown[];
  };
  // The skill has no connection details by design (no host, no credentials);
  // the guard's config type wants them, so the test supplies placeholders.
  const config = TimescaleDbConfig.parse({
    host: "example.invalid",
    port: 5432,
    database: "example",
    schema: catalog.schema,
    tables: catalog.tables.map((t) => CatalogTable.parse(t)),
  });
  return { sourceId: catalog.sourceId, config };
}

/** The example Prometheus catalog (#389), as the PromQL guard reads it. */
function prometheusSource(): {
  sourceId: string;
  catalog: { metrics: PrometheusMetric[] };
} {
  const catalog = readJson(join(EXAMPLES, "prometheus-catalog.json")) as {
    sourceId: string;
    metrics: unknown[];
  };
  return {
    sourceId: catalog.sourceId,
    catalog: { metrics: catalog.metrics.map((m) => PrometheusMetric.parse(m)) },
  };
}

const NOT_DASHBOARDS = [
  "catalog.json",
  "prometheus-catalog.json",
  "sql.json",
  "promql.json",
];

const DASHBOARD_FILES = readdirSync(EXAMPLES).filter(
  (f) => f.endsWith(".json") && !NOT_DASHBOARDS.includes(f),
);

test("there are example dashboards to check", () => {
  assert.ok(DASHBOARD_FILES.length >= 2, DASHBOARD_FILES.join(", "));
});

for (const file of DASHBOARD_FILES) {
  test(`example ${file} imports, and every query passes the guard`, async () => {
    const parsed = DashboardExportFile.safeParse(readJson(join(EXAMPLES, file)));
    assert.ok(
      parsed.success,
      parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2),
    );
    const { spec } = parsed.data;
    const { sourceId, config } = exampleSource();
    const prom = prometheusSource();
    const declared = declaredVariables(spec);

    for (const panel of spec.panels.filter(hasQuery)) {
      if (!isSqlQuery(panel.query)) {
        // PromQL, against the Prometheus catalog: accepted, and with no hint,
        // because an example should not teach what the guard warns about.
        assert.equal(
          panel.query.sourceId,
          prom.sourceId,
          `${file} ${panel.id}: sourceId`,
        );
        const check = validatePromql(queryText(panel.query), prom.catalog, declared);
        assert.ok(check.ok, `${file} ${panel.id}: ${check.ok ? "" : check.error}`);
        assert.deepEqual(check.hints ?? [], [], `${file} ${panel.id}: hints`);
        continue;
      }
      assert.equal(panel.query.sourceId, sourceId, `${file} ${panel.id}: sourceId`);
      const check = await checkSql(queryText(panel.query), config, declared);
      assert.ok(check.ok, `${file} ${panel.id}: ${check.error}`);
      const timeField = queryTimeField(panel.query);
      if (timeField) {
        // The server filters on an OUTPUT column, so the time field has to be
        // one the SELECT list produces: an alias, or the bare column itself.
        const output = new RegExp(
          `(\\bAS\\s+${timeField}\\b|^SELECT\\s+${timeField}\\b)`,
          "i",
        );
        assert.match(
          queryText(panel.query),
          output,
          `${file} ${panel.id}: timeField ${timeField}`,
        );
      }
    }
    for (const variable of spec.variables ?? []) {
      if (!variable.query) continue;
      if ("label" in variable.query) {
        const check = validatePromqlLabelValues(variable.query, prom.catalog);
        assert.ok(
          check.ok,
          `${file} variable ${variable.name}: ${check.ok ? "" : check.error}`,
        );
        continue;
      }
      // A variable's own query declares no variables and has no time filter.
      const check = await checkSql(queryText(variable.query), config);
      assert.ok(check.ok, `${file} variable ${variable.name}: ${check.error}`);
    }
  });
}

test("the examples between them use every panel kind", () => {
  const used = new Set<string>();
  for (const file of DASHBOARD_FILES) {
    const { spec } = DashboardExportFile.parse(readJson(join(EXAMPLES, file)));
    for (const panel of spec.panels) used.add(panel.viz);
  }
  assert.deepEqual(
    PANEL_KIND_NAMES.filter((k) => !used.has(k)),
    [],
    "add an example panel of each missing kind",
  );
});

interface SqlExample {
  rule: string;
  sql: string;
  variables?: string[];
  error?: string;
}

const SQL = readJson(join(EXAMPLES, "sql.json")) as {
  accepted: SqlExample[];
  rejected: SqlExample[];
};

test("every accepted SQL example passes the guard", async () => {
  const { config } = exampleSource();
  for (const ex of SQL.accepted) {
    const check = await checkSql(ex.sql, config, new Set(ex.variables ?? []));
    assert.ok(check.ok, `${ex.rule}: ${check.error}`);
  }
});

test("every rejected SQL example fails the guard, for the reason it gives", async () => {
  const { config } = exampleSource();
  for (const ex of SQL.rejected) {
    const check = await checkSql(ex.sql, config, new Set(ex.variables ?? []));
    assert.equal(check.ok, false, `${ex.rule}: accepted ${ex.sql}`);
    assert.ok(ex.error, `${ex.rule}: name the expected error`);
    assert.ok(
      check.error?.includes(ex.error),
      `${ex.rule}: expected an error containing "${ex.error}", got "${check.error}"`,
    );
  }
});

interface PromqlExample {
  rule: string;
  promql: string;
  variables?: string[];
  error?: string;
}

const PROMQL = readJson(join(EXAMPLES, "promql.json")) as {
  accepted: PromqlExample[];
  rejected: PromqlExample[];
};

test("every accepted PromQL example passes the guard, with no hint (#389)", () => {
  const { catalog } = prometheusSource();
  for (const ex of PROMQL.accepted) {
    const check = validatePromql(ex.promql, catalog, new Set(ex.variables ?? []));
    assert.ok(check.ok, `${ex.rule}: ${check.ok ? "" : check.error}`);
    assert.deepEqual(check.hints ?? [], [], `${ex.rule}: hints`);
  }
});

/** What the guard says about each rejected PromQL example. */
function promqlRejections(): string[] {
  const { catalog } = prometheusSource();
  return PROMQL.rejected.map((ex) => {
    const check = validatePromql(ex.promql, catalog, new Set(ex.variables ?? []));
    assert.equal(check.ok, false, `${ex.rule}: accepted ${ex.promql}`);
    assert.ok(ex.error, `${ex.rule}: name the expected error`);
    const error = check.ok ? "" : (check.error ?? "");
    assert.ok(
      error.includes(ex.error),
      `${ex.rule}: expected an error containing "${ex.error}", got "${error}"`,
    );
    return error;
  });
}

test("every rejected PromQL example fails the guard, for the reason it gives", () => {
  promqlRejections();
});

test("every error in the PromQL rules table is one the guard gives for an example", () => {
  const errors = promqlRejections();
  const rows = read("references/promql-rules.md")
    .split("\n")
    .filter((l) => l.startsWith("| ") && !l.startsWith("| Rule"))
    .map(
      (l) =>
        l
          .split(" | ")
          .at(-1)
          ?.replace(/^`|` \|$/g, "") ?? "",
    );
  assert.ok(rows.length >= 10, rows.join("\n"));
  for (const row of rows) {
    assert.ok(
      errors.some((e) => e.includes(row)),
      `promql-rules.md says "${row}", which no rejected example in promql.json produces`,
    );
  }
});

test("each kind that runs a query says what it is with PromQL", () => {
  const text = read("references/panel-kinds.md");
  for (const kind of PANEL_KINDS) {
    if (kind.query === "none") continue;
    const section = text.split(`### \`${kind.kind}\``)[1]?.split("\n### ")[0] ?? "";
    assert.match(section, /With PromQL:/, `${kind.kind}: add a "With PromQL:" line`);
  }
});

test("the reference lists exactly the registered panel kinds, in order", () => {
  const kinds = [
    ...read("references/panel-kinds.md").matchAll(/^### `([a-z-]+)`$/gm),
  ].map((m) => m[1]);
  assert.deepEqual(kinds, [...PANEL_KIND_NAMES]);
});

test("the reference marks the kinds that run no query and the ones that need a time field", () => {
  const text = read("references/panel-kinds.md");
  for (const kind of PANEL_KINDS) {
    const section = text.split(`### \`${kind.kind}\``)[1]?.split("\n### ")[0] ?? "";
    assert.equal(
      section.includes("Runs no query."),
      kind.query === "none",
      `${kind.kind}: "Runs no query." should appear exactly when the kind has no query`,
    );
    assert.equal(
      section.includes("Requires `query.timeField`."),
      kind.requiresTimeField === true,
      `${kind.kind}: "Requires \`query.timeField\`." should appear exactly when it does`,
    );
  }
});

/** The backticked names on the reference line that starts with `label`. */
function listed(label: string): string[] {
  const line = read("references/ir.md")
    .split("\n")
    .find((l) => l.startsWith(label));
  assert.ok(line, `references/ir.md has no line starting "${label}"`);
  return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

test("the reference's value formats and color tokens are the IR's", () => {
  assert.deepEqual(listed("Value formats:"), [...ValueFormat.options]);
  assert.deepEqual(listed("Color tokens:"), Object.keys(COLOR_TOKENS));
});

test("the reference documents every field of both query languages (#383)", () => {
  const reference = read("references/ir.md");
  for (const schema of [SqlQuery, PromqlQuery, LabelValuesQuery]) {
    for (const field of Object.keys(schema.shape)) {
      assert.ok(
        reference.includes(`\`${field}\``),
        `references/ir.md does not name \`${field}\``,
      );
    }
  }
});

test("the skill carries no connection details, credentials or route calls", () => {
  const files = [
    "SKILL.md",
    ...readdirSync(join(SKILL, "references")).map((f) => `references/${f}`),
    ...readdirSync(EXAMPLES).map((f) => `examples/${f}`),
  ];
  for (const file of files) {
    const text = read(file);
    for (const pattern of [
      /postgres(ql)?:\/\//i,
      /"(host|port|password|user(name)?|secretRef)"\s*:/i,
      /\/api\//,
      /Authorization:/i,
      /Bearer /,
    ]) {
      assert.doesNotMatch(text, pattern, `${file} matches ${pattern}`);
    }
  }
});

test("the guidance's link example is a valid panel, and its self link fits a dashboard declaring the variable (#375)", () => {
  const text = read("references/guidance.md");
  const section = text.slice(text.indexOf("## Links"));
  const json = section.match(/```json\n([\s\S]*?)\n```/)?.[1];
  assert.ok(json, "guidance.md has no JSON example under ## Links");
  const panel = Panel.parse(JSON.parse(json));
  assert.ok((panel.links ?? []).length >= 2);
  // The self link sets a variable, so it holds on a dashboard that declares it.
  const result = Dashboard.safeParse({
    specVersion: SPEC_VERSION,
    title: "Fleet",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 15000,
    variables: [{ name: "instance", type: "enum", values: ["a", "b"] }],
    panels: [panel],
  });
  assert.ok(result.success, result.success ? "" : result.error.message);
});
