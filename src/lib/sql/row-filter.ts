import { parseSync, scanSync } from "libpg-query";
import { analyzeSelectSync, type RelationUse } from "@/lib/sql/ast";
import type { RowFilter, SqlSourceConfig } from "@/lib/registry";

/**
 * Row-level filters (#31): a mandatory tenant predicate on every table a
 * row-filtered source reads.
 *
 * WHERE THE PREDICATE GOES. Not on the outer wrapper that carries the time
 * bounds. A predicate there filters the statement's OUTPUT, and the output is
 * whatever the statement chose to call things: `SELECT 'acme' AS tenant_id,
 * sum(v) FROM m` passes `_holo.tenant_id = 'acme'` with every tenant's rows
 * summed. Instead, every reference to a real table is replaced, where it
 * stands, by that table already narrowed:
 *
 *     FROM metrics.http_requests h
 *  →  FROM (SELECT * FROM metrics.http_requests AS _holo_rf
 *           WHERE _holo_rf.tenant_id = $3) h
 *
 * so no statement — a CTE, a subquery, a join, a set operation, an alias of
 * the filter column — ever scans an unfiltered row. A CTE name is not a table
 * and is left alone; its body's own table references are rewritten.
 *
 * HOW IT IS FOUND. With the guard's own parse-tree walk (`ast.ts`), whose CTE
 * scoping is exact, and the parser's byte offsets for each table name. There
 * is no SQL deparser in play: the statement is spliced at those offsets, and
 * the result is parsed again and checked (see {@link verify}). Anything the
 * rewrite cannot vouch for is refused, never run.
 *
 * WHAT IS REFUSED, on a filtered source only: `ONLY` and `TABLESAMPLE`, which
 * apply to a table and not to the subquery standing in for it, and the alias
 * `_holo_rf`, which the rewrite reserves.
 */

/** The alias every narrowed table carries inside its subquery. Reserved. */
export const ROW_FILTER_ALIAS = "_holo_rf";

/** A row filter with its value resolved for one viewer. */
export interface RowFilterBinding {
  column: string;
  value: string;
}

/** The statement cannot be filtered as written. The author's to fix. */
export class RowFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RowFilterError";
  }
}

/**
 * The viewer has no value for the claim a source filters on. Refused rather
 * than served unfiltered.
 */
export class RowFilterDenied extends Error {
  constructor(public readonly claim: string) {
    super(`no value for the "${claim}" claim this source filters rows by`);
    this.name = "RowFilterDenied";
  }
}

/**
 * Bind a source's row filter to one viewer's claim values, or null when the
 * source has none. Throws {@link RowFilterDenied} when the viewer lacks the
 * claim, so a caller cannot fall through to an unfiltered query by accident.
 */
export function bindRowFilter(
  config: Pick<SqlSourceConfig, "rowFilter">,
  claimValue: (claim: string) => string | undefined,
): RowFilterBinding | null {
  const filter: RowFilter | undefined = config.rowFilter;
  if (!filter) return null;
  const value = claimValue(filter.claim);
  if (value === undefined || value === "") throw new RowFilterDenied(filter.claim);
  return { column: filter.column, value };
}

/**
 * Why a row filter cannot be saved on this catalog, or null. Every table must
 * have the column: a table without it would fail every query that reads it,
 * and is better refused when the source is saved.
 */
export function rowFilterProblem(config: SqlSourceConfig): string | null {
  const filter = config.rowFilter;
  if (!filter) return null;
  const without = config.tables
    .filter((t) => !t.columns.some((c) => c.name === filter.column))
    .map((t) => t.name);
  if (without.length > 0) {
    return `row filter column "${filter.column}" is not in ${without.join(", ")}; every table of a row-filtered source must have it`;
  }
  return null;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const ONLY_OR_SAMPLE: ReadonlySet<string> = new Set(["RangeTableSample"]);

/** Any `TABLESAMPLE`, or a `RangeVar` read with `ONLY` (`inh` false). */
function findUnfilterable(tree: unknown): string | null {
  let found: string | null = null;
  const visit = (value: unknown): void => {
    if (found) return;
    if (Array.isArray(value)) {
      for (const v of value) visit(v);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, field] of Object.entries(value)) {
      if (ONLY_OR_SAMPLE.has(key)) {
        found = "TABLESAMPLE";
        return;
      }
      if (key === "RangeVar" && typeof field === "object" && field !== null) {
        if ((field as { inh?: boolean }).inh !== true) {
          found = "ONLY";
          return;
        }
      }
      visit(field);
    }
  };
  visit(tree);
  return found;
}

interface NameSpan {
  /** Where the replacement starts: the name, or the `TABLE` keyword before it. */
  start: number;
  /** Where the name, `t` or `schema.t` with any `UESCAPE` clause, ends. */
  end: number;
  /** `TABLE t`, the shorthand for `SELECT * FROM t`, which takes no subquery. */
  command: boolean;
}

/** Where a relation's name is in the statement, and whether `TABLE` precedes it. */
function nameSpan(
  rel: RelationUse,
  tokens: ReadonlyArray<{ start: number; end: number }>,
  bytes: Buffer,
): NameSpan {
  const text = (t: { start: number; end: number }) =>
    bytes.subarray(t.start, t.end).toString("utf8");
  const lost = () => new RowFilterError("could not locate a table reference to filter");
  const i = tokens.findIndex((t) => t.start === rel.location);
  if (i < 0) throw lost();
  // One name part: an identifier, and for a `U&"…"` one, the `UESCAPE '…'`
  // the grammar attaches to it. Returns the index after the part.
  const part = (j: number): number => {
    if (!tokens[j]) throw lost();
    const escaped =
      /^u&/i.test(text(tokens[j])) &&
      text(tokens[j + 1] ?? tokens[j]).toLowerCase() === "uescape";
    return escaped ? j + 3 : j + 1;
  };
  let next = part(i);
  if (rel.table.schema) {
    if (!tokens[next] || text(tokens[next]) !== ".") throw lost();
    next = part(next + 1);
  }
  // `t *`, the old spelling of "and its descendant tables" (the default), is
  // part of the reference: the subquery replaces it whole.
  if (tokens[next] && text(tokens[next]) === "*") next += 1;
  const last = tokens[next - 1];
  if (!last) throw lost();
  const end = last.end;
  // `table` is a reserved word, so unquoted it can only be the command; a
  // relation called "table" is quoted and is one IDENT token.
  const prev = tokens[i - 1];
  const command = prev !== undefined && text(prev).toLowerCase() === "table";
  return { start: command ? prev.start : tokens[i].start, end, command };
}

/**
 * Narrow every real table `sql` reads to the rows whose `column` equals the
 * parameter `$param`. `sql` has already passed `validateSql`.
 */
export function applyRowFilter(sql: string, column: string, param: number): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
    throw new RowFilterError(`invalid row filter column: ${column}`);
  }
  // `$n` here is the server's own: a variable reference (#67) already
  // replaced by its placeholder. The statement's own were refused by the guard.
  const before = analyzeSelectSync(sql, { params: true });
  if (!before.ok) throw new RowFilterError(before.error);
  const unfilterable = findUnfilterable(parseSync(sql));
  if (unfilterable) {
    throw new RowFilterError(`${unfilterable} is not allowed on a row-filtered source`);
  }
  const relations = before.analysis.relations;
  if (relations.some((r) => r.alias === ROW_FILTER_ALIAS)) {
    throw new RowFilterError(`the alias ${ROW_FILTER_ALIAS} is reserved`);
  }

  const bytes = Buffer.from(sql, "utf8");
  const tokens = scanSync(sql).tokens;
  const predicate = `WHERE ${ROW_FILTER_ALIAS}.${column} = $${param}`;

  // Right to left, so each splice leaves the earlier offsets where they were.
  const spans = relations
    .map((rel) => ({ rel, span: nameSpan(rel, tokens, bytes) }))
    .sort((a, b) => b.span.start - a.span.start);
  let out = bytes;
  for (const { rel, span } of spans) {
    // The name as the server resolves it, from the parse tree: already
    // case-folded and unescaped, so quoting it exactly names the same table
    // whatever spelling the statement used.
    const name = rel.table.schema
      ? `${quoteIdent(rel.table.schema)}.${quoteIdent(rel.table.name)}`
      : quoteIdent(rel.table.name);
    // A table without an alias was known by its own name; the subquery keeps
    // that name, so `t.col` and `t.*` still resolve.
    const alias = rel.alias === undefined ? ` AS ${quoteIdent(rel.table.name)}` : "";
    const narrowed = `(SELECT * FROM ${name} AS ${ROW_FILTER_ALIAS} ${predicate})${alias}`;
    out = Buffer.concat([
      out.subarray(0, span.start),
      Buffer.from(span.command ? `SELECT * FROM ${narrowed}` : narrowed, "utf8"),
      out.subarray(span.end),
    ]);
  }
  const rewritten = out.toString("utf8");
  verify(rewritten, relations.length, column, param);
  return rewritten;
}

/**
 * Prove the rewrite did what it says, from a fresh parse of its output:
 * every real table is read under the reserved alias, as the only FROM item of
 * a SELECT whose WHERE is exactly the filter, and there are as many as there
 * were tables before. A splice that went anywhere else fails here, not in
 * front of a tenant.
 */
function verify(sql: string, expected: number, column: string, param: number): void {
  const after = analyzeSelectSync(sql, { params: true });
  if (!after.ok) throw new RowFilterError(`row filter rewrite failed: ${after.error}`);
  const { relations } = after.analysis;
  if (
    relations.length !== expected ||
    relations.some((r) => r.alias !== ROW_FILTER_ALIAS)
  ) {
    throw new RowFilterError("row filter rewrite failed: a table was left unfiltered");
  }
  let narrowed = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const v of value) visit(v);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const stmt = (value as { SelectStmt?: Record<string, unknown> }).SelectStmt;
    if (stmt && isNarrowing(stmt, column, param)) narrowed++;
    for (const field of Object.values(value)) visit(field);
  };
  visit(parseSync(sql));
  if (narrowed !== expected) {
    throw new RowFilterError("row filter rewrite failed: a filter is missing");
  }
}

/** `SELECT * FROM <table> AS _holo_rf WHERE _holo_rf.<column> = $<param>`, exactly. */
function isNarrowing(
  stmt: Record<string, unknown>,
  column: string,
  param: number,
): boolean {
  const from = stmt.fromClause as Array<{
    RangeVar?: { alias?: { aliasname?: string } };
  }>;
  if (from?.length !== 1 || from[0].RangeVar?.alias?.aliasname !== ROW_FILTER_ALIAS) {
    return false;
  }
  const where = stmt.whereClause as
    | {
        A_Expr?: {
          kind?: string;
          name?: Array<{ String?: { sval?: string } }>;
          lexpr?: { ColumnRef?: { fields?: Array<{ String?: { sval?: string } }> } };
          rexpr?: { ParamRef?: { number?: number } };
        };
      }
    | undefined;
  const expr = where?.A_Expr;
  const fields = expr?.lexpr?.ColumnRef?.fields?.map((f) => f.String?.sval);
  return (
    expr?.kind === "AEXPR_OP" &&
    expr.name?.length === 1 &&
    expr.name[0].String?.sval === "=" &&
    fields?.length === 2 &&
    fields[0] === ROW_FILTER_ALIAS &&
    fields[1] === column.toLowerCase() &&
    expr.rexpr?.ParamRef?.number === param &&
    Object.keys(stmt).every((k) =>
      ["targetList", "fromClause", "whereClause", "limitOption", "op"].includes(k),
    )
  );
}
