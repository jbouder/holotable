import { config } from "@/lib/config";
import { recordSqlRejection, type SqlRejectionReason } from "@/lib/metrics";
import {
  allowedTables,
  type CatalogTable,
  type SourceConfig,
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
 * Refuse a statement: build the result and count it.
 *
 * Every rejection below goes through here, so the
 * `holotable_sql_validation_rejections_total` counter cannot drift from the
 * guard — a new rule that returns its own object would be a missing metric,
 * and a new rule that forgets the `reason` would not compile.
 */
function reject(reason: SqlRejectionReason, error: string): ValidationResult {
  recordSqlRejection(reason);
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

function hasFunctionCall(haystack: string, fn: string): boolean {
  return new RegExp(`\\b${fn}\\s*\\(`, "i").test(haystack);
}

function timeFunctionError(fn: string): ValidationResult {
  return reject("time", `disallowed function ${fn}(): ${TIME_ERROR_SUFFIX}`);
}

/**
 * Validate an untrusted SELECT against the selected source's catalog.
 */
export async function validateSql(
  sql: string,
  source: SourceConfig,
): Promise<ValidationResult> {
  const trimmed = stripTerminators(sql);
  if (trimmed.length === 0) return reject("empty", "empty SQL");

  // The parse-tree pass: one SELECT, allowlisted constructs only, and a full
  // account of the relations, functions, keywords and literals it contains.
  const analyzed = await analyzeSelect(trimmed);
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
  source: SourceConfig,
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
}

/**
 * Build the final, guarded executable plan. Assumes `validateSql` already
 * passed. Wraps the validated query as a subquery and injects the server-owned
 * time range via bound parameters on the declared `timeField`.
 */
export function buildExecutablePlan(input: {
  sql: string;
  timeField?: string;
  from: Date;
  to: Date;
}): ExecutablePlan {
  const inner = stripTerminators(input.sql);
  const limit = config.maxQueryRows;

  const params: unknown[] = [];

  let sql: string;
  if (input.timeField) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.timeField)) {
      throw new Error(`invalid timeField: ${input.timeField}`);
    }
    params.push(input.from, input.to);
    sql = `SELECT * FROM (${inner}) AS _holo
WHERE _holo.${input.timeField} >= $1::timestamptz
  AND _holo.${input.timeField} < $2::timestamptz
LIMIT ${limit}`;
  } else {
    sql = `SELECT * FROM (${inner}) AS _holo LIMIT ${limit}`;
  }

  return { sql, params, timeField: input.timeField };
}
