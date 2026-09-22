/**
 * The name and literal denylists the SQL guard refuses on.
 *
 * Data only, and deliberately free of every server import, so the guard
 * (`src/lib/sql/safety.ts`, which is authoritative and runs the real
 * PostgreSQL parser over the statement) and the editor's hint layer
 * (`src/lib/sql/hints.ts`, which runs in the browser and only ever guesses
 * *toward* the guard) read one copy of the lists rather than two that drift.
 *
 * Adding an entry here tightens both at once. Nothing in this file decides
 * anything on its own.
 */

// Functions that could bypass the allowlist, exfiltrate data, or hurt the
// server. Matched against the unqualified, lowercased name of every call in the
// parse tree, so `pg_catalog.pg_sleep(1)` and `"PG_SLEEP"(1)` are both caught.
//
// The list is deliberately over-broad and spans dialects: the entries below in
// ClickHouse vocabulary cost nothing on a PostgreSQL target, and a source
// driver for another engine inherits them for free. The PostgreSQL entries are
// the ones that matter today.
export const FORBIDDEN_FUNCTIONS = [
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
export const FORBIDDEN_TIME_FUNCTIONS = [
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
export const TIME_INPUT_LITERALS = new Set(["now", "today", "tomorrow", "yesterday"]);

export const FORBIDDEN_FUNCTION_SET = new Set(FORBIDDEN_FUNCTIONS);
export const FORBIDDEN_TIME_FUNCTION_SET = new Set(FORBIDDEN_TIME_FUNCTIONS);
