import { config } from "@/lib/config";
import { allowedTables, type SourceConfig } from "@/lib/registry";

/**
 * SQL safety guard.
 *
 * ALL model-authored SQL is untrusted. Before any statement reaches the metrics
 * store it must pass these checks:
 *
 *   - SELECT-only, single statement (no `;` chaining, no DDL/DML).
 *   - No comments (they can smuggle disallowed constructs).
 *   - No dangerous table functions (file/url/remote/s3/... exfiltration or
 *     allowlist bypass) and no access to PostgreSQL system catalogs.
 *   - No time / non-deterministic functions: the model must NOT filter time.
 *   - Every referenced table must be in the catalog allowlist of the single
 *     selected source.
 *
 * At execution the server wraps the validated query and injects the dashboard
 * time range on the declared `timeField` using bound query parameters, plus
 * read-only settings and row/time limits. This guarantees the model controls
 * neither the time window nor resource usage.
 */

const FORBIDDEN_KEYWORDS = [
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "create",
  "truncate",
  "grant",
  "revoke",
  "attach",
  "detach",
  "rename",
  "optimize",
  "system",
  "set",
  "use",
  "kill",
  "exchange",
  "freeze",
  "into",
  "outfile",
  "format",
  "current_date",
  "current_time",
  "current_timestamp",
  "localtime",
  "localtimestamp",
  // Parenless server/session identity. PostgreSQL accepts these as bare
  // keywords, so hasFunctionCall() never sees them.
  "current_catalog",
  "current_role",
  "current_schema",
  "current_user",
  "session_user",
  "system_user",
];

// Table functions / sources that could bypass the allowlist or exfiltrate data.
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

  // PostgreSQL: cross-database and filesystem access.
  "dblink",
  "dblink_connect",
  "lo_import",
  "lo_export",
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
  // `localtime` and `localtimestamp` take no parentheses and are covered by
  // FORBIDDEN_KEYWORDS above; these are the call-syntax ones.
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

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

function hasWord(haystack: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, "i").test(haystack);
}

function hasFunctionCall(haystack: string, fn: string): boolean {
  return new RegExp(`\\b${fn}\\s*\\(`, "i").test(haystack);
}

/**
 * Validate an untrusted SELECT against the selected source's catalog.
 */
export function validateSql(sql: string, source: SourceConfig): ValidationResult {
  const trimmed = sql.trim().replace(/;\s*$/, "");

  if (trimmed.length === 0) return { ok: false, error: "empty SQL" };
  if (trimmed.includes(";")) {
    return { ok: false, error: "multiple statements are not allowed" };
  }
  if (trimmed.includes("--") || trimmed.includes("/*") || trimmed.includes("#")) {
    return { ok: false, error: "comments are not allowed" };
  }
  if (!/^(select|with)\b/i.test(trimmed)) {
    return { ok: false, error: "only SELECT/WITH queries are allowed" };
  }
  if (/\$\d+/.test(trimmed)) {
    return { ok: false, error: "query parameters are reserved by the server" };
  }

  for (const kw of FORBIDDEN_KEYWORDS) {
    if (hasWord(trimmed, kw)) {
      return { ok: false, error: `disallowed keyword: ${kw}` };
    }
  }
  for (const fn of FORBIDDEN_FUNCTIONS) {
    if (hasFunctionCall(trimmed, fn)) {
      return { ok: false, error: `disallowed table function: ${fn}()` };
    }
  }
  for (const fn of FORBIDDEN_TIME_FUNCTIONS) {
    if (hasFunctionCall(trimmed, fn)) {
      return {
        ok: false,
        error:
          `disallowed function ${fn}(): the server owns the time range, and a ` +
          `spec must produce the same query on every tick`,
      };
    }
  }

  // Referenced tables must all be in the allowlist. `FROM (subquery)` does not
  // match at all, because the character class cannot start on `(`.
  //
  // `)` is excluded from the class so that a reference which ends a CTE body —
  // `WITH b AS (SELECT ts FROM http_requests) SELECT ...` — is read as
  // `http_requests` and not `http_requests)`. Without that, every CTE over a
  // real table was rejected as an invalid table reference.
  const allow = allowedTables(source);
  const refRe = /\b(?:from|join)\s+([^\s(),;]+)/gi;
  for (
    let m: RegExpExecArray | null = refRe.exec(trimmed);
    m !== null;
    m = refRe.exec(trimmed)
  ) {
    const ref = m[1].replace(/[`"]/g, "");
    if (ref.startsWith("(")) continue; // subquery
    if (!IDENTIFIER_RE.test(ref)) {
      return { ok: false, error: `invalid table reference: ${m[1]}` };
    }
    if (!allow.has(ref.toLowerCase())) {
      return { ok: false, error: `table not in catalog allowlist: ${ref}` };
    }
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
  const inner = input.sql.trim().replace(/;\s*$/, "");
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
