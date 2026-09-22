import { config } from "@/lib/config";
import { recordSqlRejection, type SqlRejectionReason } from "@/lib/metrics";
import { allowedTables, type SourceConfig } from "@/lib/registry";
import { analyzeSelect, containsComment } from "@/lib/sql/ast";

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
 */

// Functions that could bypass the allowlist, exfiltrate data, or hurt the
// server. Matched against the unqualified, lowercased name of every call in the
// parse tree, so `pg_catalog.pg_sleep(1)` and `"PG_SLEEP"(1)` are both caught.
//
// The list is deliberately over-broad and spans dialects: the entries below in
// ClickHouse vocabulary cost nothing on a PostgreSQL target, and a source
// driver for another engine inherits them for free. The PostgreSQL entries are
// the ones that matter today.
const FORBIDDEN_FUNCTIONS = [
  // ClickHouse table functions.
  "file",
  "url",
  "remote",
  "remotesecure",
  "cluster",
  "clusterallreplicas",
  "s3",
  "s3cluster",
  "hdfs",
  "mysql",
  "postgresql",
  "jdbc",
  "odbc",
  "mongodb",
  "redis",
  "input",
  "executable",
  "dictionary",

  // PostgreSQL: cross-database, filesystem and large-object access.
  "dblink",
  "dblink_connect",
  "lo_import",
  "lo_export",
  "lo_get",
  "lo_put",
  "lo_create",
  "lo_unlink",
  "pg_read_file",
  "pg_read_binary_file",
  "pg_stat_file",
  "pg_ls_dir",
  "pg_ls_logdir",
  "pg_ls_waldir",
  "pg_ls_tmpdir",
  "pg_ls_archive_statusdir",

  // PostgreSQL: these take a *query string* and execute it, which walks
  // straight around the catalog allowlist. The application's read-only role
  // holds SELECT on the whole metrics schema, not just the catalog tables, so
  // this is a real bypass and not merely an information leak.
  "query_to_xml",
  "query_to_xmlschema",
  "query_to_xml_and_xmlschema",
  "table_to_xml",
  "table_to_xmlschema",
  "table_to_xml_and_xmlschema",
  "cursor_to_xml",
  "cursor_to_xmlschema",

  // PostgreSQL: server configuration and session state.
  "current_setting",
  "set_config",
  "pg_settings_get_flags",

  // PostgreSQL: server and connection identity.
  "version",
  "inet_server_addr",
  "inet_server_port",
  "inet_client_addr",
  "inet_client_port",
  "pg_backend_pid",

  // PostgreSQL: unbounded server-side delay. The statement timeout caps a
  // single call, but a poller tick that always burns its full timeout ties up a
  // connection on every tick, for every subscriber.
  "pg_sleep",
  "pg_sleep_for",
  "pg_sleep_until",

  // PostgreSQL: side effects an unprivileged role can still cause from inside a
  // read-only transaction — advisory locks that outlive the statement timeout's
  // protection, signals to the application's own other backends, NOTIFY, and
  // sequence advancement.
  "pg_advisory_lock",
  "pg_advisory_lock_shared",
  "pg_advisory_xact_lock",
  "pg_advisory_xact_lock_shared",
  "pg_try_advisory_lock",
  "pg_try_advisory_lock_shared",
  "pg_try_advisory_xact_lock",
  "pg_try_advisory_xact_lock_shared",
  "pg_advisory_unlock",
  "pg_advisory_unlock_all",
  "pg_advisory_unlock_shared",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_notify",
  "pg_logical_emit_message",
  "pg_export_snapshot",
  "nextval",
  "setval",
];

// Non-deterministic / time functions: the model must not filter or branch on
// time, and must not introduce a value that changes between two ticks of the
// same spec.
//
// `now()` and `current_timestamp` alone do not enforce that: PostgreSQL has
// several exact synonyms and several non-transactional variants, and every one
// of them has to be here or the server does not in fact own the time range.
const FORBIDDEN_TIME_FUNCTIONS = [
  // ClickHouse.
  "now",
  "now64",
  "today",
  "yesterday",
  "currentdatabase",
  "rand",
  "randcanonical",

  // PostgreSQL time. `current_timestamp`, `current_date`, `current_time`,
  // `localtime` and `localtimestamp` take no parentheses; the parser reports
  // them as value keywords and they are rejected below. These are the
  // call-syntax ones.
  "clock_timestamp",
  "statement_timestamp",
  "transaction_timestamp",
  "timeofday",
  "age",

  // PostgreSQL non-determinism.
  "random",
  "random_normal",
  "gen_random_uuid",
  "uuid_generate_v1",
  "uuid_generate_v4",
];

// PostgreSQL's date/time input accepts these words as *values*: `'now'`,
// `'today'::date` and `WHERE ts > 'yesterday'` all read the clock at plan time,
// with no function call for a denylist to see. Matched case-insensitively
// after trimming, exactly as the datetime parser does.
const TIME_INPUT_LITERALS = new Set(["now", "today", "tomorrow", "yesterday"]);

const FORBIDDEN_FUNCTION_SET = new Set(FORBIDDEN_FUNCTIONS);
const FORBIDDEN_TIME_FUNCTION_SET = new Set(FORBIDDEN_TIME_FUNCTIONS);

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
