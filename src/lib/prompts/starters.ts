import { liveCatalogTables, type CatalogSubject } from "@/lib/catalog/health";
import type { CatalogColumn, CatalogTable, SourceRecord } from "@/lib/registry";
import { isTimestampType } from "@/lib/source-form";

/**
 * The one-click starter prompts, derived from the source the author has
 * selected.
 *
 * They used to be three hard-coded lists that all described the seeded demo
 * schema, so pointing Holotable at any other database made every suggestion
 * wrong — at exactly the moment a new user most needs a working example. These
 * are built from the catalog instead: the tables and columns that source is
 * actually allowed to query.
 *
 * Three properties are deliberate:
 *
 * - **No model call.** This is templates over the catalog, so the chips are
 *   free, instant, and the same every render. A suggestion that costs a token
 *   budget is a suggestion nobody ships on an empty state.
 * - **Only live tables.** The source of tables is {@link liveCatalogTables},
 *   so a table the last refresh could not find never becomes a suggestion. A
 *   starter that is guaranteed to fail is worse than no starter.
 * - **Only plain identifiers.** Catalog names come from a database the
 *   operator may not control, and a chip's whole job is to put text into the
 *   prompt box. Anything that is not an ordinary SQL identifier is skipped
 *   rather than escaped: there is no wording a template can wrap around
 *   arbitrary text that keeps it data, and a source with an odd name simply
 *   falls back to the generic set.
 *
 * Nothing here decides what may be queried. The allowlist, the guard and the
 * server's time handling are unchanged; this only decides what is *offered*.
 */

/** Which surface is asking: one question, or a whole dashboard. */
export type StarterKind = "panel" | "dashboard";

export interface StarterOptions {
  /** Most starters to return. Defaults to {@link DEFAULT_STARTER_LIMIT}. */
  limit?: number;
}

export const DEFAULT_STARTER_LIMIT = 5;

/**
 * An ordinary unquoted SQL identifier, which is what a table or column has to
 * look like before its name is pasted into a prompt box. Deliberately narrower
 * than what `CatalogTable` accepts.
 */
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

function isPlainIdentifier(name: string): boolean {
  return PLAIN_IDENTIFIER.test(name);
}

/** `information_schema` spellings for the types worth averaging. */
const NUMERIC_TYPE =
  /^(smallint|integer|bigint|int2|int4|int8|int|decimal|numeric|real|double precision|float4|float8|float|money)\b/i;

/** ...and for the ones worth grouping by. */
const TEXTUAL_TYPE = /^(text|character|varchar|char|name|citext|uuid|"char")\b/i;

/** Integers, which can be either depending on what the name says they are. */
const INTEGER_TYPE = /^(smallint|integer|bigint|int2|int4|int8|int)\b/i;

/**
 * Column names that usually hold a small set of repeated values. Grouping by a
 * high-cardinality column produces a useless panel, and the catalog carries no
 * statistics, so the name is the only signal available — a wrong guess costs a
 * chip nobody clicks, which is the right way for this to fail.
 */
const CATEGORY_NAME =
  /(^|_)(status|code|state|kind|type|category|class|level|severity|region|zone|az|host|hostname|node|instance|service|route|path|endpoint|method|verb|env|environment|cluster|namespace|queue|topic|device|sensor|tenant|account|operation|action|event|result|outcome)(_|$)/i;

/**
 * A column worth averaging. The name is checked as well as the type, because
 * an HTTP `status` is a `smallint` and its average is a number with no
 * meaning — the most confidently wrong suggestion this file could make.
 */
function isMeasure(column: CatalogColumn): boolean {
  return NUMERIC_TYPE.test(column.type.trim()) && !CATEGORY_NAME.test(column.name);
}

/** A column worth grouping by: a category name over a type that can hold one. */
function isDimension(column: CatalogColumn): boolean {
  const type = column.type.trim();
  return (
    CATEGORY_NAME.test(column.name) &&
    (TEXTUAL_TYPE.test(type) || INTEGER_TYPE.test(type))
  );
}

/** A table only contributes starters if everything named in them is safe to name. */
function usableTable(table: CatalogTable): boolean {
  return isPlainIdentifier(table.name) && table.columns.length > 0;
}

function pick(
  columns: CatalogColumn[],
  match: (column: CatalogColumn) => boolean,
): string | null {
  const found = columns.filter((c) => isPlainIdentifier(c.name)).find(match);
  return found ? found.name : null;
}

/**
 * The time column to phrase "over time" around: the declared `timeField` when
 * there is one, otherwise the first timestamp-typed column. Its *name* is
 * never used — the model reads the catalog — so only its existence matters,
 * and a table without one gets no time-series starter rather than one the
 * model would have to invent a column for.
 */
function hasTimeColumn(table: CatalogTable): boolean {
  if (table.timeField) return true;
  return table.columns.some((column) => isTimestampType(column.type));
}

/**
 * One table's starters, best first. Rank matters: {@link buildStarters} takes
 * rank 0 from every table before it takes anyone's rank 1, so a source with
 * several tables offers a spread rather than five questions about the first.
 */
function tableStarters(table: CatalogTable, kind: StarterKind): string[] {
  const name = table.name;
  const timed = hasTimeColumn(table);
  const numeric = pick(table.columns, isMeasure);
  const category = pick(table.columns, isDimension);
  const out: string[] = [];

  if (kind === "dashboard") {
    if (timed) out.push(`An overview of ${name}: volume over time and a total count`);
    if (numeric && timed)
      out.push(`Chart average and maximum ${numeric} from ${name} over time`);
    if (category && timed)
      out.push(`${name} volume over time, broken down by ${category}`);
    if (category && numeric)
      out.push(`Top ${category} in ${name} by average ${numeric}, as a bar chart`);
    out.push(`A stat panel with the number of rows in ${name}`);
    return out;
  }

  if (timed) out.push(`Chart ${name} volume over time`);
  out.push(`How many rows are in ${name}?`);
  if (numeric && timed) out.push(`Show average ${numeric} from ${name} over time`);
  if (category) out.push(`Top ${category} in ${name} by count`);
  if (category && numeric) out.push(`Average ${numeric} by ${category} in ${name}`);
  return out;
}

/**
 * The fallback when the catalog names nothing usable. Schema-free on purpose:
 * these are the only starter strings in the product that are not derived from
 * a real catalog, and naming a table here is how the old hard-coded lists went
 * wrong. A source in this state is also the one the catalog-health notice is
 * already warning about, so the chips are a courtesy, not the fix.
 */
export function genericStarters(kind: StarterKind): string[] {
  return kind === "dashboard"
    ? [
        "An overview of this data source: totals and volume over time",
        "Chart the main measures over the last hour",
        "The most recent rows as a table, plus a stat panel of the total count",
      ]
    : [
        "How many rows are in this data source?",
        "Chart row volume over time",
        "Show the most recent rows",
      ];
}

/**
 * Starter prompts for one source, best first and de-duplicated.
 *
 * Deterministic: the same catalog always produces the same list in the same
 * order, which is what makes it testable and what stops the chips shuffling
 * under the pointer between renders.
 */
export function buildStarters(
  source: CatalogSubject,
  kind: StarterKind,
  opts: StarterOptions = {},
): string[] {
  const limit = opts.limit ?? DEFAULT_STARTER_LIMIT;
  if (limit <= 0) return [];

  const perTable = liveCatalogTables(source)
    .filter(usableTable)
    .map((table) => tableStarters(table, kind));

  const out: string[] = [];
  const seen = new Set<string>();
  const deepest = perTable.reduce((n, list) => Math.max(n, list.length), 0);
  for (let rank = 0; rank < deepest && out.length < limit; rank++) {
    for (const list of perTable) {
      const starter = list[rank];
      if (starter === undefined || seen.has(starter)) continue;
      seen.add(starter);
      out.push(starter);
      if (out.length >= limit) break;
    }
  }

  return out.length > 0 ? out : genericStarters(kind).slice(0, limit);
}

/**
 * Starter *descriptions* for the natural-language source drafter.
 *
 * This surface has no selected source — it is how a source comes to exist — so
 * there is no catalog to read. The next best real thing is the sources the
 * workspace already has: the operator's own host, port and database, which is
 * almost always where the next source lives too. With none, the fallback shows
 * the shape of a description without inventing a schema.
 */
export function buildSourceDescriptionStarters(
  sources: Pick<SourceRecord, "config">[],
  opts: StarterOptions = {},
): string[] {
  const limit = opts.limit ?? 3;
  const out: string[] = [];
  const seen = new Set<string>();

  for (const source of sources) {
    if (out.length >= limit) break;
    const cfg = source.config;
    const table = cfg.tables.find(usableTable);
    if (!table || !isHostLike(cfg.host) || !isPlainIdentifier(cfg.database)) continue;
    if (!isPlainIdentifier(cfg.schema)) continue;
    const columns = table.columns
      .filter((column) => isPlainIdentifier(column.name))
      .slice(0, 4)
      .map((column) => column.name);
    if (columns.length === 0) continue;
    const starter = `PostgreSQL at ${cfg.host}:${cfg.port}, database ${cfg.database}, schema ${cfg.schema}. Track ${table.name} (${columns.join(", ")}).`;
    if (seen.has(starter)) continue;
    seen.add(starter);
    out.push(starter);
  }

  return out.length > 0 ? out : GENERIC_SOURCE_DESCRIPTIONS.slice(0, limit);
}

/**
 * Format, not schema. These name no table, because the point of a fallback is
 * to show what a description looks like when there is nothing real to copy.
 *
 * The connection details are bracketed placeholders, never a plausible
 * address: a realistic-looking `db.internal` drafted straight into a source
 * that saved and then failed on Test with a DNS error. The drafter carries a
 * placeholder through verbatim, and the form refuses to save or discover
 * while one is still in a field.
 */
export const GENERIC_SOURCE_DESCRIPTIONS = [
  "PostgreSQL at <host>:5432, database <database>, schema public. Track a table of events with a timestamp column, a category, and a numeric measure.",
  "TimescaleDB hypertable keyed on time, with an identifier column and two numeric measurement columns.",
];

/** A host or address, as loosely as a connection field is allowed to be one. */
function isHostLike(host: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(host);
}
