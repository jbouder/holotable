import { config } from "@/lib/config";
import { recordSqlRejection, type SqlRejectionReason } from "@/lib/metrics";
import { allowedTables, type SourceConfig } from "@/lib/registry";
import { analyzeSelect, containsComment } from "@/lib/sql/ast";
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
