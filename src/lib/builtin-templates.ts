import { liveCatalogTables, type CatalogSubject } from "@/lib/catalog/health";
import type { Panel, ValueFormat } from "@/lib/ir";
import type { CatalogColumn, CatalogTable } from "@/lib/registry";
import { isTimestampType } from "@/lib/source-form";
import type { Template, TemplateKind } from "@/lib/templates";

/**
 * The starter templates that ship with the app: the four golden signals,
 * parameterized by a source's own tables.
 *
 * A first-run user has no templates, which is exactly when a template would
 * help most. These fill that gap without shipping a schema: like
 * `src/lib/prompts/starters.ts`, they are built from the catalog the source
 * actually allowlists, so the panels name real tables and real columns or they
 * are not offered at all.
 *
 * They are derived, not stored. There is no row behind one, nothing to delete,
 * and no migration when the set changes — a built-in exists for as long as the
 * catalog supports it and disappears when it stops. That also means a built-in
 * costs nothing to keep correct: it cannot drift away from a database the way
 * a saved template can.
 *
 * Three constraints shape the SQL below, and all three come from the rest of
 * the system rather than from taste:
 *
 * - **No time filter.** The server owns the time range (invariant 4) and
 *   injects it on the output column named by `timeField`, so every template
 *   here aliases its bucket column `bucket` and declares it.
 * - **Plain identifiers only.** Catalog names come from a database the
 *   operator may not control and are interpolated into SQL text here, so a
 *   name that is not an ordinary unquoted identifier disqualifies its table or
 *   column rather than being escaped. This is the same rule `starters.ts`
 *   applies for the same reason, stated separately because the consequence of
 *   breaking it is different: there it is a bad suggestion, here it would be
 *   generated SQL.
 * - **`date_trunc`, not `time_bucket`.** Both pass the guard and both work on
 *   TimescaleDB, but a source can be plain PostgreSQL and a shipped template
 *   that fails there is worse than one bucket of lower resolution.
 *
 * Nothing here decides what may be queried or executed. A built-in is applied
 * through the same picker, the same `validateSql` check against the chosen
 * source, and the same save path as any other template.
 */

/** The four signals, in the order a dashboard lays them out. */
export const GOLDEN_SIGNALS = ["rate", "errors", "duration", "saturation"] as const;
export type GoldenSignal = (typeof GOLDEN_SIGNALS)[number];

/** How many tables of a catalog contribute templates. */
const MAX_TABLES = 3;

/** An ordinary unquoted SQL identifier — see the note above. */
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

function isPlainIdentifier(name: string): boolean {
  return PLAIN_IDENTIFIER.test(name);
}

const NUMERIC_TYPE =
  /^(smallint|integer|bigint|int2|int4|int8|int|decimal|numeric|real|double precision|float4|float8|float|money)\b/i;

const TEXTUAL_TYPE = /^(text|character|varchar|char|name|citext|uuid|"char")\b/i;
const INTEGER_TYPE = /^(smallint|integer|bigint|int2|int4|int8|int)\b/i;

/**
 * Column names that classify a row rather than measure it — the breakdown the
 * errors signal is built on. The catalog carries no statistics and no
 * semantics, so the name is the only signal available; a wrong guess costs one
 * template nobody applies, which is the right way for this to fail.
 */
const CATEGORY_NAME =
  /(^|_)(status|code|state|result|outcome|severity|level|error|errors|kind|type|class)(_|$)/i;

/** Names that read like "how long did it take". */
const DURATION_NAME =
  /(^|_)(duration|latency|elapsed|response|request|time|took|ms|millis|seconds|secs)(_|$)/i;

/** Names that read like "how full is it". */
const SATURATION_NAME =
  /(^|_)(pct|percent|percentage|util|utilization|usage|used|load|saturation|depth|backlog|lag|queue|pending|inflight|open|active|connections|cpu|mem|memory|heap|disk|bytes)(_|$)/i;

function isNumericColumn(column: CatalogColumn): boolean {
  return (
    isPlainIdentifier(column.name) &&
    NUMERIC_TYPE.test(column.type.trim()) &&
    !CATEGORY_NAME.test(column.name)
  );
}

function isCategoryColumn(column: CatalogColumn): boolean {
  const type = column.type.trim();
  return (
    isPlainIdentifier(column.name) &&
    CATEGORY_NAME.test(column.name) &&
    (TEXTUAL_TYPE.test(type) || INTEGER_TYPE.test(type))
  );
}

/**
 * The column the server will filter time on, or null.
 *
 * The declared `timeField` first — its author said so — then the first
 * timestamp-typed column. A table with neither gets no templates at all: every
 * signal below is a time series, and one that cannot be narrowed to the
 * dashboard's window would read the whole table on every tick.
 */
function timeColumn(table: CatalogTable): string | null {
  if (table.timeField && isPlainIdentifier(table.timeField)) return table.timeField;
  const found = table.columns.find(
    (c) => isPlainIdentifier(c.name) && isTimestampType(c.type),
  );
  return found ? found.name : null;
}

/** The measure a signal reads: the first column whose name fits it. */
function measure(table: CatalogTable, name: RegExp): CatalogColumn | null {
  return table.columns.find((c) => isNumericColumn(c) && name.test(c.name)) ?? null;
}

/**
 * The format a measure's name implies. Deliberately narrow: an unrecognised
 * name gets plain numbers rather than a unit it might not be in.
 */
function formatFor(column: CatalogColumn): ValueFormat {
  const name = column.name;
  if (/(^|_)(ms|millis|milliseconds)(_|$)/i.test(name)) return "ms";
  if (/(^|_)(pct|percent|percentage)(_|$)/i.test(name)) return "percent";
  if (/(^|_)bytes(_|$)/i.test(name)) return "bytes";
  return "number";
}

/** A signal's panel plus the name its template goes by in the picker. */
interface SignalTemplate {
  panel: Panel;
  /** What follows "Rate — " etc. Kept out of the panel title, which stands
   *  alone on a dashboard where the signal is obvious from the grid. */
  label: string;
}

/** One signal against one table, or null when the table cannot serve it. */
function signalPanel(
  table: CatalogTable,
  signal: GoldenSignal,
  sourceId: string,
): SignalTemplate | null {
  const time = timeColumn(table);
  if (!time || !isPlainIdentifier(table.name)) return null;
  const from = table.name;
  const bucket = `date_trunc('minute', ${time}) AS bucket`;
  const base = { sourceId, timeField: "bucket" };
  const layout = { x: 0, y: 0, w: 6, h: 4 };

  switch (signal) {
    case "rate":
      return {
        label: from,
        panel: {
          id: "rate",
          title: `${from} rate`,
          description: `Rows written to ${from} per minute — the traffic this table sees.`,
          viz: "line",
          format: "number",
          query: {
            ...base,
            sql: `SELECT ${bucket}, count(*) AS events\nFROM ${from}\nGROUP BY bucket\nORDER BY bucket`,
          },
          layout,
        },
      };

    case "errors": {
      const category = table.columns.find(isCategoryColumn);
      if (!category) return null;
      return {
        label: `${from} by ${category.name}`,
        panel: {
          id: "errors",
          title: `${from} by ${category.name}`,
          description:
            `Rows per minute broken down by ${category.name}. The catalog does not say which ` +
            `value means failure, so the breakdown is shown whole rather than guessed at — ` +
            `narrow it in the SQL once you know.`,
          viz: "table",
          query: {
            ...base,
            sql: `SELECT ${bucket}, ${category.name}, count(*) AS events\nFROM ${from}\nGROUP BY bucket, ${category.name}\nORDER BY bucket DESC, events DESC`,
          },
          layout,
        },
      };
    }

    case "duration": {
      const column = measure(table, DURATION_NAME);
      if (!column) return null;
      return {
        label: `${from} ${column.name}`,
        panel: {
          id: "duration",
          title: `${from} ${column.name}`,
          description: `Average and peak ${column.name} per minute.`,
          viz: "line",
          format: formatFor(column),
          query: {
            ...base,
            sql: `SELECT ${bucket}, avg(${column.name}) AS average, max(${column.name}) AS peak\nFROM ${from}\nGROUP BY bucket\nORDER BY bucket`,
          },
          layout,
        },
      };
    }

    case "saturation": {
      const column = measure(table, SATURATION_NAME);
      if (!column) return null;
      return {
        label: `${from} ${column.name}`,
        panel: {
          id: "saturation",
          title: `${from} ${column.name} peak`,
          description: `The highest ${column.name} seen in each minute.`,
          viz: "area",
          format: formatFor(column),
          query: {
            ...base,
            sql: `SELECT ${bucket}, max(${column.name}) AS peak\nFROM ${from}\nGROUP BY bucket\nORDER BY bucket`,
          },
          layout,
        },
      };
    }
  }
}

/** Two-up, in signal order. The grid is 12 columns wide and a panel is 6. */
function arrange(panels: Panel[]): Panel[] {
  return panels.map((panel, i) => ({
    ...panel,
    layout: { ...panel.layout, x: (i % 2) * 6, y: Math.floor(i / 2) * 4 },
  }));
}

/**
 * The built-in templates for one source: a panel template per signal a table
 * can serve, plus a golden-signals dashboard for each table that can serve
 * more than one.
 *
 * Deterministic — the same catalog always produces the same list in the same
 * order — which is what makes it testable and stops the picker reshuffling
 * under the pointer.
 */
export function buildBuiltinTemplates(
  source: CatalogSubject,
  kind?: TemplateKind,
): Template[] {
  const out: Template[] = [];
  const tables = liveCatalogTables(source)
    .filter((t) => isPlainIdentifier(t.name) && t.columns.length > 0 && timeColumn(t))
    .slice(0, MAX_TABLES);

  for (const table of tables) {
    const signals = GOLDEN_SIGNALS.map((signal) => ({
      signal,
      built: signalPanel(table, signal, source.id),
    })).filter(
      (s): s is { signal: GoldenSignal; built: SignalTemplate } => s.built !== null,
    );

    if (kind !== "dashboard") {
      for (const { signal, built } of signals) {
        out.push({
          id: `builtin:${source.id}:${table.name}:${signal}`,
          origin: "builtin",
          kind: "panel",
          name: `${signal[0].toUpperCase()}${signal.slice(1)} — ${built.label}`,
          description: built.panel.description,
          body: { kind: "panel", panel: built.panel },
        });
      }
    }

    // A one-signal "dashboard" is the panel template with extra steps.
    if (kind !== "panel" && signals.length > 1) {
      out.push({
        id: `builtin:${source.id}:${table.name}:golden-signals`,
        origin: "builtin",
        kind: "dashboard",
        name: `Golden signals — ${table.name}`,
        description: `Rate, errors, duration and saturation for ${table.name}, as far as its columns support them.`,
        body: {
          kind: "dashboard",
          dashboard: {
            title: `${table.name} golden signals`,
            timeRange: { from: "now-1h", to: "now" },
            refreshIntervalMs: 30_000,
            panels: arrange(signals.map((s) => s.built.panel)),
          },
        },
      });
    }
  }

  return out;
}
