import { parseSync } from "libpg-query";
import { config } from "@/lib/config";
import { recordSqlRejection, type SqlRejectionReason } from "@/lib/metrics";
import { applyRowFilter, type RowFilterBinding } from "@/lib/sql/row-filter";
import {
  referencedNames,
  scanVariables,
  scanVariablesSync,
  substituteVariables,
  VariableError,
  type VariableValues,
} from "@/lib/sql/variables";
import {
  allowedTables,
  type CatalogTable,
  type SqlSourceConfig,
  unexposedColumns,
} from "@/lib/registry";
import {
  analyzeSelect,
  containsComment,
  type SelectAnalysis,
  type TableRef,
} from "@/lib/sql/ast";
import {
  FORBIDDEN_FUNCTION_SET,
  FORBIDDEN_FUNCTIONS,
  FORBIDDEN_TIME_FUNCTION_SET,
  FORBIDDEN_TIME_FUNCTIONS,
  TIME_INPUT_LITERALS,
} from "@/lib/sql/denylist";

/**
 * SQL safety guard.
 *
 * ALL model-authored SQL is untrusted. Before any statement reaches the metrics
 * store it must pass these checks:
 *
 *   - It parses, with the real PostgreSQL grammar, as exactly one SELECT built
 *     only from allowlisted constructs (`src/lib/sql/ast.ts`). No other
 *     statement type anywhere in the tree — including inside a CTE — no
 *     `SELECT INTO`, no row locking, no `$N` parameters.
 *   - No comments (they can swallow the wrapper `buildExecutablePlan` adds).
 *   - No dangerous functions: file/url/remote exfiltration, functions that
 *     execute a query string, server-side sleeps, session state, and server
 *     identity. Checked by name on every call the parser found, in any position.
 *   - No time / non-deterministic functions, keywords or literals: the model
 *     must NOT filter time, and a spec must produce the same query on every tick.
 *   - Every relation the statement reads must be in the catalog allowlist of the
 *     single selected source. Relations are taken from the parse tree, so a
 *     reference in a nested CTE, a lateral subquery, a set-operation arm or a
 *     LIMIT expression is checked the same as one in the top-level FROM, and a
 *     CTE alias is recognised as the CTE it names.
 *   - No column the catalog marks unexposed may be read, in any position, by
 *     name or wholesale (see {@link checkColumns}).
 *   - A `:name` variable reference (#67) must name a variable the dashboard
 *     declares. It is checked as the `$n` it will run as, and its value is
 *     only ever a bound parameter (`src/lib/sql/variables.ts`).
 *
 * At execution the server wraps the validated query and injects the dashboard
 * time range on the declared `timeField` using bound query parameters, plus
 * read-only settings and row/time limits. This guarantees the model controls
 * neither the time window nor resource usage.
 *
 * Denylists over raw text remain as a second layer after the parse-tree pass.
 * They are cheap, they do not depend on the parser, and the only thing they
 * over-reject is a string literal that happens to contain a forbidden call.
 * The lists themselves live in `src/lib/sql/denylist.ts`, which the editor's
 * hint layer reads too, so the browser can warn about the same names this
 * guard refuses without a second copy of them.
 */

const TIME_ERROR_SUFFIX =
  "the server owns the time range, and a spec must produce the same query on every tick";

export interface ValidationResult {
  ok: boolean;
  error?: string;
  /**
   * Which class of rule refused the statement. A fixed enum, unlike `error`,
   * which names the offending table or function and is therefore attacker-
   * influenced text. Only the reason is safe to use as a metric label.
   */
  reason?: SqlRejectionReason;
}

/**
 * Refuse a statement.
 *
 * Every rejection below goes through here, so a new rule that forgets the
 * `reason` would not compile. Counting happens once, in {@link validateSql},
 * on whatever {@link checkSql} returned, so the
 * `holotable_sql_validation_rejections_total` counter cannot drift from the
 * guard either.
 */
function reject(reason: SqlRejectionReason, error: string): ValidationResult {
  return { ok: false, error, reason };
}

/**
 * Trim the statement and drop every trailing terminator. PostgreSQL accepts
 * `SELECT 1;;` as one statement, but the validated text is later spliced into
 * `SELECT * FROM (…) AS _holo`, where a leftover `;` is a syntax error. Found by
 * the fuzz suite; pinned in `test/sql-safety.test.ts`.
 */
function stripTerminators(sql: string): string {
  return sql.replace(/[\s;]+$/, "").trim();
}

const NO_VARIABLES: ReadonlySet<string> = new Set();

/**
 * The statement with its variable references replaced by placeholders, or the
 * reason it is refused: a `$n` of its own, a reference to a variable the
 * dashboard does not declare, or text the scanner cannot tokenize.
 */
async function expandVariables(
  sql: string,
  declared: ReadonlySet<string>,
): Promise<
  | { ok: true; sql: string; placeholders: boolean }
  | { ok: false; result: ValidationResult }
> {
  let scanned: Awaited<ReturnType<typeof scanVariables>>;
  try {
    scanned = await scanVariables(sql);
  } catch {
    return {
      ok: false,
      result: reject("structure", "only SELECT/WITH queries are allowed"),
    };
  }
  if (scanned.hasParam) {
    return {
      ok: false,
      result: reject("structure", "query parameters are reserved by the server"),
    };
  }
  const names = referencedNames(scanned.refs);
  const unknown = names.find((n) => !declared.has(n));
  if (unknown !== undefined) {
    return {
      ok: false,
      result: reject(
        "variable",
        `undeclared variable :${unknown.slice(0, 64)}; declare it on the dashboard or remove it`,
      ),
    };
  }
  if (names.length === 0) return { ok: true, sql, placeholders: false };
  return {
    ok: true,
    sql: substituteVariables(sql, scanned.refs, (n) => names.indexOf(n) + 1),
    placeholders: true,
  };
}

function hasFunctionCall(haystack: string, fn: string): boolean {
  return new RegExp(`\\b${fn}\\s*\\(`, "i").test(haystack);
}

function timeFunctionError(fn: string): ValidationResult {
  return reject("time", `disallowed function ${fn}(): ${TIME_ERROR_SUFFIX}`);
}

/**
 * Validate an untrusted SELECT against the selected source's catalog, and
 * count a rejection. Every path that is about to execute a statement, or is
 * reporting on one an author wrote, goes through here.
 */
export async function validateSql(
  sql: string,
  source: SqlSourceConfig,
  variables: ReadonlySet<string> = NO_VARIABLES,
): Promise<ValidationResult> {
  const result = await checkSql(sql, source, variables);
  if (!result.ok && result.reason) recordSqlRejection(result.reason);
  return result;
}

/**
 * The same verdict as {@link validateSql}, uncounted.
 *
 * For a *what if*: asking whether a stored statement would still pass against
 * a catalog nobody has saved yet (#267). A hypothetical is not a refusal, and
 * counting it would put a spike in the rejection metric every time an admin
 * opened a preview. Nothing that executes SQL may use this instead of
 * `validateSql`; the two return the same result, so the only thing lost would
 * be the metric.
 */
export async function checkSql(
  sql: string,
  source: SqlSourceConfig,
  variables: ReadonlySet<string> = NO_VARIABLES,
): Promise<ValidationResult> {
  const stripped = stripTerminators(sql);
  if (stripped.length === 0) return reject("empty", "empty SQL");

  // Variable references (#67), found by PostgreSQL's own scanner. Every one
  // must be declared, and the statement is checked from here on as it will
  // run: with each reference a `$n`. A `$n` the statement spelled itself is
  // refused first, so the only parameters the parse below accepts are ours.
  const expanded = await expandVariables(stripped, variables);
  if (!expanded.ok) return expanded.result;
  const trimmed = expanded.sql;

  // The parse-tree pass: one SELECT, allowlisted constructs only, and a full
  // account of the relations, functions, keywords and literals it contains.
  const analyzed = await analyzeSelect(trimmed, { params: expanded.placeholders });
  if (!analyzed.ok) return reject("structure", analyzed.error);
  if (await containsComment(trimmed)) {
    return reject("comment", "comments are not allowed");
  }
  const { tables, functions, keywords, strings } = analyzed.analysis;

  // Every parenless value keyword the grammar knows is either a clock reading
  // (`current_timestamp`, `localtime`, …) or server identity (`current_user`,
  // `session_user`, `current_schema`, …). None has a place in a spec.
  if (keywords.length > 0) {
    return reject("keyword", `disallowed keyword: ${keywords[0]}`);
  }

  for (const fn of functions) {
    if (FORBIDDEN_FUNCTION_SET.has(fn.name)) {
      return reject("function", `disallowed table function: ${fn.name}()`);
    }
    if (FORBIDDEN_TIME_FUNCTION_SET.has(fn.name)) return timeFunctionError(fn.name);
  }

  for (const literal of strings) {
    if (TIME_INPUT_LITERALS.has(literal.trim().toLowerCase())) {
      return reject("time", `disallowed time literal '${literal}': ${TIME_ERROR_SUFFIX}`);
    }
  }

  // Every relation the statement reads must be in the allowlist. CTE names are
  // already resolved away by the analysis; what is left is what the server
  // will look up, spelled the way the server will look it up: the parser has
  // folded unquoted identifiers to lowercase and kept quoted ones as written,
  // so the comparison is exact. Lowercasing here would let `"HTTP_REQUESTS"`
  // pass as `http_requests`, and those are two different relations.
  const allow = allowedTables(source);
  for (const table of tables) {
    const ref = table.schema ? `${table.schema}.${table.name}` : table.name;
    if (!allow.has(ref)) {
      return reject("catalog", `table not in catalog allowlist: ${ref}`);
    }
  }

  const columns = checkColumns(analyzed.analysis, source);
  if (columns) return reject("column", columns);

  // Second layer: the same function denylists over the raw text, independent
  // of the parser.
  for (const fn of FORBIDDEN_FUNCTIONS) {
    if (hasFunctionCall(trimmed, fn)) {
      return reject("function", `disallowed table function: ${fn}()`);
    }
  }
  for (const fn of FORBIDDEN_TIME_FUNCTIONS) {
    if (hasFunctionCall(trimmed, fn)) return timeFunctionError(fn);
  }

  return { ok: true };
}

/**
 * The per-column half of the catalog: why the statement reads a column its
 * author marked unexposed, or null when it reads none.
 *
 * Runs after the table check, so every table here is allowlisted. A source
 * with no unexposed column on any table the statement reads is untouched.
 * Otherwise the rule is deliberately name-based and errs toward refusing:
 *
 *   - A column reference whose last name part is unexposed on *any* table the
 *     statement reads is refused, however it is qualified and wherever it
 *     appears — select list, WHERE, ORDER BY, a join condition, a CTE. Filtering
 *     on a hidden column is reading it one bit at a time. The cost is that
 *     `s.email` on an exposed `signups.email` is refused when the statement
 *     also reads a `users` table whose `email` is hidden; the author can split
 *     the query or ask for the column to be exposed.
 *   - `*` is refused when its SELECT reads such a table directly, and `x.*`
 *     when `x` names one. `*` over a subquery or a CTE is fine: it can only
 *     expand to what that body selected, and the body is checked on its own.
 *   - A whole-row reference — `u`, `metrics.users`, `row_to_json(u)`, `(u).ssn`,
 *     the functional `ssn(u)` — is refused when it names such a table, because
 *     the row carries every column. PostgreSQL prefers a column over a relation
 *     of the same name, so this can refuse a column that merely shares a name
 *     with a restricted table or alias; it never lets a row through.
 *   - A column alias list on such a table (`users AS u(a, b)`) renames columns
 *     by position, and `NATURAL JOIN` matches on every shared column name
 *     without naming one, so both are refused there; `USING` names its columns
 *     and is checked like any other reference.
 *
 * Exported for testing; `validateSql` is the only caller.
 */
export function checkColumns(
  analysis: SelectAnalysis,
  source: SqlSourceConfig,
): string | null {
  const catalogTable = (ref: TableRef): CatalogTable | undefined =>
    source.tables.find(
      (t) => t.name === ref.name && (!ref.schema || ref.schema === source.schema),
    );

  // Every unexposed column of every table the statement reads, by name.
  const hidden = new Map<string, string>();
  const restricted = (ref: TableRef): CatalogTable | null => {
    const table = catalogTable(ref);
    return table && unexposedColumns(table).size > 0 ? table : null;
  };
  for (const ref of analysis.tables) {
    const table = restricted(ref);
    if (!table) continue;
    for (const column of unexposedColumns(table)) {
      if (!hidden.has(column)) hidden.set(column, table.name);
    }
  }
  if (hidden.size === 0) return null;

  // Every name the statement could use to mean a restricted table's whole row.
  const rows = new Map<string, string>();
  for (const relation of analysis.relations) {
    const table = restricted(relation.table);
    if (!table) continue;
    if (relation.renamesColumns) {
      return `column aliases on ${table.name} are not allowed: it has unexposed columns`;
    }
    rows.set(table.name, table.name);
    if (relation.alias) rows.set(relation.alias, table.name);
  }
  for (const join of analysis.joins) {
    const table = join.tables.map(restricted).find((t) => t !== null);
    for (const column of join.using) {
      const owner = hidden.get(column);
      if (owner) return `column not exposed: ${owner}.${column}`;
    }
    if (!table) continue;
    if (join.natural) {
      return `NATURAL JOIN on ${table.name} is not allowed: it has unexposed columns; join with ON or USING instead`;
    }
    if (join.renamesColumns) {
      return `column aliases on a join over ${table.name} are not allowed: it has unexposed columns`;
    }
    for (const alias of join.aliases) rows.set(alias, table.name);
  }

  for (const column of analysis.columns) {
    const last = column.path[column.path.length - 1];
    if (column.star) {
      const table =
        last === undefined
          ? column.from.map(restricted).find((t) => t !== null)?.name
          : rows.get(last);
      if (table) {
        return `SELECT * is not allowed on ${table}: it has unexposed columns; name the columns instead`;
      }
      continue;
    }
    const owner = hidden.get(last);
    if (owner) return `column not exposed: ${owner}.${last}`;
    const row = rows.get(last);
    if (row) {
      return `whole-row reference to ${row} is not allowed: it has unexposed columns; name the columns instead`;
    }
  }
  return null;
}

export interface ExecutablePlan {
  sql: string;
  params: unknown[];
  /** The output column the server filters time on, if any. Used for diagnostics. */
  timeField?: string;
  /**
   * The variables bound (#67), in the order of their parameters, which come
   * last. Present only when the statement references any.
   */
  variables?: string[];
  /**
   * The row cap (#486), and how the executor reads what it cut. With a time
   * field the plan keeps the newest `maxRows` rows in the statement's own
   * order and adds two bookkeeping columns, {@link POSITION_COLUMN} and
   * {@link TOTAL_COLUMN}, which the executor strips; without one it asks for
   * one row past the cap, so a cut is seen rather than guessed.
   */
  maxRows?: number;
  ranked?: boolean;
}

/** The statement's own row order, kept through the newest-rows cut. */
export const POSITION_COLUMN = "_holo_pos";
/** How many rows the window held before the cut. */
export const TOTAL_COLUMN = "_holo_total";

/**
 * Build the final, guarded executable plan. Assumes `validateSql` already
 * passed. Wraps the validated query as a subquery and injects the server-owned
 * time range via bound parameters on the declared `timeField`.
 *
 * `rowFilter` is required, and `null` only for a source without one, so a
 * call site cannot forget it (#31). When set, every table the statement reads
 * is narrowed to the viewer's rows before the statement sees them
 * (`applyRowFilter`), with the value bound as a parameter. Bind it with
 * `bindRowFilter`, which refuses a viewer who lacks the claim.
 */
export function buildExecutablePlan(input: {
  sql: string;
  timeField?: string;
  from: Date;
  to: Date;
  rowFilter: RowFilterBinding | null;
  /**
   * The values of the variables the statement references (#67), already
   * checked against what the dashboard allows. Each is bound after the time
   * bounds and the row-filter value; none is ever written into the text.
   */
  variables?: VariableValues;
  /**
   * The rows the panel asks for (#499). Never above `MAX_QUERY_ROWS`: the
   * smaller of the two is the plan's cap, and anything not a positive whole
   * number is the server's own.
   */
  maxRows?: number;
}): ExecutablePlan {
  const asked = input.maxRows;
  const limit =
    asked !== undefined && Number.isInteger(asked) && asked > 0
      ? Math.min(asked, config.maxQueryRows)
      : config.maxQueryRows;

  const params: unknown[] = [];
  let inner = stripTerminators(input.sql);

  // A statement with neither a `:` nor a `$` has no reference and no
  // parameter to find. Anything else is scanned, which needs the parser
  // `validateSql` loaded; if it somehow is not, this throws and no plan is
  // built.
  const scanned = /[:$]/.test(inner)
    ? scanVariablesSync(inner)
    : { refs: [], hasParam: false };
  if (scanned.hasParam)
    throw new VariableError("query parameters are reserved by the server");
  const names = referencedNames(scanned.refs);
  const values = names.map((name) => {
    const value = input.variables?.[name];
    if (value === undefined) throw new VariableError(`no value for variable :${name}`);
    // A copy: the caller's array is not the plan's to hold on to.
    return typeof value === "string" ? value : [...value];
  });
  if (names.length > 0) {
    const first = (input.timeField ? 2 : 0) + (input.rowFilter ? 1 : 0) + 1;
    inner = substituteVariables(inner, scanned.refs, (n) => first + names.indexOf(n));
  }

  if (input.rowFilter) {
    // The time bounds, when there are any, are $1 and $2 below.
    const param = input.timeField ? 3 : 1;
    inner = applyRowFilter(inner, input.rowFilter.column, param);
  }

  let sql: string;
  if (input.timeField) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.timeField)) {
      throw new Error(`invalid timeField: ${input.timeField}`);
    }
    params.push(input.from, input.to);
    if (input.rowFilter) params.push(input.rowFilter.value);
    // The newest rows, not the first (#486): a series ordered oldest-first
    // used to keep its oldest 5,000 and lose the live edge. The cut is by the
    // time field, newest first; the rows that survive go back into the
    // statement's own order by their position in it, so a newest-first log
    // stays newest-first. `row_number() OVER ()` numbers rows as the
    // subquery delivers them, before the cut's sort.
    const tf = input.timeField;
    sql = `SELECT * FROM (SELECT _holo.*, row_number() OVER () AS ${POSITION_COLUMN}, count(*) OVER () AS ${TOTAL_COLUMN}
FROM (${inner}) AS _holo
WHERE _holo.${tf} >= $1::timestamptz
  AND _holo.${tf} < $2::timestamptz
ORDER BY _holo.${tf} DESC, ${POSITION_COLUMN} DESC
LIMIT ${limit}) AS _holo_kept
ORDER BY _holo_kept.${POSITION_COLUMN}`;
  } else {
    if (input.rowFilter) params.push(input.rowFilter.value);
    // No time to rank by, so the first rows, as before: one more than the cap
    // is how the executor knows the cut happened.
    sql = `SELECT * FROM (${inner}) AS _holo LIMIT ${limit + 1}`;
  }
  verifyWrapper(sql, inner, input.timeField || undefined, limit);
  params.push(...values);

  return {
    sql,
    params,
    timeField: input.timeField,
    ...(names.length > 0 ? { variables: names } : {}),
    maxRows: limit,
    ranked: Boolean(input.timeField),
  };
}

/**
 * The parse tree's byte offsets into the text it was parsed from: every such
 * field `@pgsql/types` declares for this parser. They move when the statement
 * is embedded in the wrapper, and are all that does.
 */
const OFFSET_KEYS = new Set([
  "location",
  "name_location",
  "stmt_location",
  "stmt_len",
  "list_start",
  "list_end",
  "rexpr_list_start",
  "rexpr_list_end",
]);

/** A parse tree without source offsets, so two spellings of one tree compare. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!OFFSET_KEYS.has(k)) out[k] = shape(v);
  }
  return out;
}

type Node = Record<string, unknown>;
const select = (n: unknown): Node | undefined =>
  (n as { SelectStmt?: Node } | undefined)?.SelectStmt;
const subselect = (n: Node | undefined, alias: string): Node | undefined => {
  const from = n?.fromClause as Array<{ RangeSubselect?: Node }> | undefined;
  const range = from?.length === 1 ? from[0].RangeSubselect : undefined;
  return (range?.alias as { aliasname?: string } | undefined)?.aliasname === alias
    ? select(range?.subquery)
    : undefined;
};
const limitOf = (n: Node | undefined): number | undefined =>
  (n?.limitCount as { A_Const?: { ival?: { ival?: number } } } | undefined)?.A_Const?.ival
    ?.ival;

/**
 * Prove the wrapper is what it says, from a fresh parse of its output (#486):
 * one SELECT whose `_holo` subquery is exactly the statement that was
 * checked, under a constant `LIMIT` at the cap — the newest rows by the time
 * field when there is one — and nothing else. A template edit that put the
 * limit, the filter or the statement anywhere else fails here, not in front
 * of a source. Exported for unit testing.
 */
export function verifyWrapper(
  sql: string,
  inner: string,
  timeField: string | undefined,
  limit: number,
): void {
  const fail = (why: string): never => {
    throw new Error(`plan wrapper failed verification: ${why}`);
  };
  const stmts = (parseSync(sql) as { stmts?: Array<{ stmt: unknown }> }).stmts ?? [];
  if (stmts.length !== 1) fail("not one statement");
  const outer = select(stmts[0].stmt);
  if (!outer) fail("not a SELECT");
  let holo: Node | undefined;
  if (timeField) {
    if (outer?.whereClause || outer?.limitCount) fail("outer query filters or limits");
    const cut = subselect(outer, "_holo_kept");
    if (!cut?.whereClause) fail("no time filter");
    if (limitOf(cut) !== limit) fail("limit is not the cap");
    const first = (cut?.sortClause as Array<{ SortBy?: Node }> | undefined)?.[0]?.SortBy;
    const field = (
      first?.node as { ColumnRef?: { fields?: Array<{ String?: { sval?: string } }> } }
    )?.ColumnRef?.fields?.map((f) => f.String?.sval);
    // Unquoted, so Postgres folds it; the identifier check allows ASCII only.
    const folded = `_holo.${timeField.toLowerCase()}`;
    if (first?.sortby_dir !== "SORTBY_DESC" || field?.join(".") !== folded) {
      fail("the cut is not newest-first on the time field");
    }
    holo = subselect(cut, "_holo");
  } else {
    if (outer?.whereClause || outer?.sortClause) fail("outer query filters or sorts");
    if (limitOf(outer) !== limit + 1) fail("limit is not the cap");
    holo = subselect(outer, "_holo");
  }
  const checked = (parseSync(inner) as { stmts?: Array<{ stmt: unknown }> }).stmts ?? [];
  if (
    checked.length !== 1 ||
    JSON.stringify(shape(holo)) !== JSON.stringify(shape(select(checked[0].stmt)))
  ) {
    fail("the wrapped statement is not the checked one");
  }
}
