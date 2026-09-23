/**
 * What pressing **Test** on a source actually establishes (#126).
 *
 * It used to connect, `SELECT 1`, and answer `connection succeeded`. That
 * proves a socket and a login and nothing else — not how far away the database
 * is, not what it is, not which role was really used, and above all not the
 * claim the whole security model rests on: that the role is read-only.
 *
 * This module is the shape of the richer answer and the judgements made about
 * it. It is pure and reaches nothing; `src/lib/timescaledb/client.ts` collects
 * the facts, and the data-sources page renders them.
 */

/** Round-trip cost, split so a slow link and a slow database look different. */
export interface TestLatency {
  /** Connect, TLS and authentication. */
  connectMs: number;
  /** One trivial statement once connected. */
  queryMs: number;
}

/** What the server says it is. */
export interface TestServer {
  /** `version()` verbatim — long, and kept so nothing is hidden. */
  version: string;
  /** The TimescaleDB extension version, when the extension is installed. */
  timescaledb: string | null;
}

/** Which role the connection really got, and what it can see. */
export interface TestRole {
  /** `current_user` — the effective role a statement runs as. */
  currentUser: string;
  /** `session_user` — who logged in. Differs after a `SET ROLE`. */
  sessionUser: string;
  /** `search_path` as it stands after the session pin. */
  searchPath: string;
}

/** The outcome of deliberately attempting a write inside a rolled-back probe. */
export type ReadOnlyVerdict =
  /** The server refused the write. The expected, healthy answer. */
  | "refused"
  /** The write went through. The role is more privileged than assumed. */
  | "accepted"
  /** The probe could not be run (the session failed earlier). */
  | "unknown";

export interface TestReadOnly {
  verdict: ReadOnlyVerdict;
  /** The server's own words when it refused, or what happened when it did not. */
  detail: string;
}

/** Whether one allowlisted table is actually there and actually readable. */
export interface TestTable {
  table: string;
  reachable: boolean;
  /** Why not, or why it was not checked. */
  error?: string;
}

export interface SourceTestResult {
  /** Did the connection and the basic read succeed. */
  ok: boolean;
  message: string;
  latency?: TestLatency;
  server?: TestServer;
  role?: TestRole;
  readOnly?: TestReadOnly;
  /** One entry per allowlisted table, in catalog order. */
  tables?: TestTable[];
}

/**
 * `"PostgreSQL 16.4 (Debian …) on x86_64…"` → `"PostgreSQL 16.4"`.
 *
 * The full string is kept on the result; this is what fits on one line. A
 * version string that does not match the usual shape is truncated rather than
 * dropped — an unfamiliar server is exactly when the operator wants to see
 * what it said.
 */
export function shortVersion(version: string): string {
  const match = /^([A-Za-z][A-Za-z ]*?)\s+(\d+(?:\.\d+)*)/.exec(version.trim());
  if (match) return `${match[1]} ${match[2]}`;
  return version.trim().slice(0, 60);
}

/** `1234.7` → `"1.2 s"`, `87.3` → `"87 ms"`. Latency people can read. */
export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/**
 * How alarmed to be about the read-only probe.
 *
 * `accepted` is the one result here that is a *finding* rather than a status:
 * the transaction was opened `READ ONLY`, so a write that succeeds means the
 * server did not honour it, and every guarantee downstream — SELECT-only
 * validation, read-only execution — is resting on an assumption that has just
 * been shown to be false for this source (invariant 5).
 */
export function readOnlyTone(verdict: ReadOnlyVerdict): "ok" | "warning" | "danger" {
  switch (verdict) {
    case "refused":
      return "ok";
    case "accepted":
      return "danger";
    default:
      return "warning";
  }
}

/** The sentence shown beside the verdict. */
export function readOnlyHeadline(verdict: ReadOnlyVerdict): string {
  switch (verdict) {
    case "refused":
      return "Read-only confirmed — the server refused a write";
    case "accepted":
      return "This role can write. A read-only transaction did not stop it.";
    default:
      return "Read-only not proven — the probe did not run";
  }
}

/** `3 of 4 tables readable`, or the singular when there is one. */
export function summarizeTables(tables: TestTable[]): string {
  const reachable = tables.filter((t) => t.reachable).length;
  if (tables.length === 0) return "No tables are allowlisted";
  if (reachable === tables.length) {
    return tables.length === 1
      ? "1 table readable"
      : `All ${tables.length} tables readable`;
  }
  return `${reachable} of ${tables.length} tables readable`;
}

/**
 * Is anything on this result worth acting on even though the test "passed"?
 *
 * A green tick over a writable role or a missing table is the failure mode the
 * old one-line answer had, so the page keys its overall tone off this rather
 * than off `ok` alone.
 */
export function hasFinding(result: SourceTestResult): boolean {
  if (!result.ok) return true;
  if (result.readOnly && result.readOnly.verdict !== "refused") return true;
  return (result.tables ?? []).some((t) => !t.reachable);
}
