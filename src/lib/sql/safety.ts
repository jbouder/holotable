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
];

// Table functions / sources that could bypass the allowlist or exfiltrate data.
const FORBIDDEN_FUNCTIONS = [
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
  "dblink",
  "dblink_connect",
  "lo_import",
  "pg_read_file",
  "pg_read_binary_file",
  "pg_ls_dir",
];

// Non-deterministic / time functions: the model must not filter or branch on time.
const FORBIDDEN_TIME_FUNCTIONS = [
  "now",
  "now64",
  "today",
  "yesterday",
  "currentdatabase",
  "rand",
  "randcanonical",
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
        error: `disallowed function ${fn}(): the server owns the time range`,
      };
    }
  }

  // Referenced tables must all be in the allowlist. Subqueries `FROM (` are ok.
  const allow = allowedTables(source);
  const refRe = /\b(?:from|join)\s+([^\s(,;]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = refRe.exec(trimmed)) !== null) {
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

  return { sql, params };
}
