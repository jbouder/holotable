import type { Identity } from "@/lib/auth/claims";
import { insertAuditRow } from "@/lib/db/repo";
import { currentRequest, log, REDACTED, redactFields, redactString } from "@/lib/log";
import { recordAuditWriteFailure } from "@/lib/metrics";

/**
 * The audit log (#30): one append-only row per thing someone did.
 *
 * Who signed in and out, who created, changed or deleted a dashboard, a source
 * or a template, who ran which statement against which source, who asked the
 * model for what, and — just as much — who was refused. The JSON log says some
 * of this too, but a log is rotated away and is not something a workspace
 * admin can query; this is.
 *
 * Three rules hold here:
 *
 * 1. **It never breaks a request.** {@link audit} is fire-and-forget: it
 *    builds the row synchronously, hands it to the writer, and returns. A
 *    write that fails is logged and counted
 *    (`holotable_audit_write_failures_total`) and the request carries on. A
 *    dashboard that will not save because the audit table is unreachable is
 *    worse than a gap in the log that an alert points at.
 *
 * 2. **Nothing sensitive is stored.** {@link auditRow} is the single place a
 *    row is built and runs `detail` through the same redaction pass as every
 *    log line (#23): credential shapes are scrubbed, secret-named keys are
 *    replaced, and SQL and prompt text become a digest. On top of that it
 *    drops any key that could carry query results ({@link RESULT_KEY}), so a
 *    metric value cannot reach the table even if a call site passes one.
 *
 * 3. **Facts come from trusted values.** The actor is the verified identity,
 *    the workspace is the one the action was authorized in, and the request id
 *    is read from the request context rather than passed in.
 *
 * Executions are recorded where a person runs a statement: the explore and
 * editor preview (`/api/query`), a dashboard chat's tool call, and opening a
 * dashboard's stream, whose row lists every panel's source and statement
 * digest. The shared poller's refreshes are not: each one is the same
 * statements on a timer, on behalf of whoever is subscribed, and a row per
 * panel per tick would bury everything else.
 */

/** Every event the log records. The migration deliberately has no CHECK on it. */
export const AUDIT_ACTIONS = [
  "auth.login",
  "auth.logout",
  "auth.backchannel_logout",
  "authz.denied",
  "dashboard.create",
  "dashboard.update",
  "dashboard.delete",
  "dashboard.stream",
  "dashboard.generate",
  "dashboard.chat",
  "query.execute",
  "source.create",
  "source.update",
  "source.delete",
  "source.test",
  "source.refresh",
  "source.discover",
  "source.draft",
  "template.create",
  "template.delete",
  "workspace.limits.update",
  "annotation.create",
  "annotation.delete",
  "share.create",
  "share.revoke",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Mirrors the migration's CHECK. */
export const AUDIT_OUTCOMES = ["success", "failure", "denied"] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export type AuditResourceType =
  | "dashboard"
  | "source"
  | "template"
  | "workspace"
  | "annotation";

/** What an event acted on. */
export interface AuditResource {
  type: AuditResourceType;
  id: string;
}

/**
 * Someone other than a signed-in person: the realm ending sessions over the
 * back channel (#28), named by the subject its signed logout token carried.
 */
export interface AuditSystemActor {
  kind: "realm";
  sub: string;
}

export interface AuditEvent {
  /** The verified identity, or the realm. */
  actor: Identity | AuditSystemActor;
  action: AuditAction;
  /** The workspace the action was authorized in; null for a sign-in or sign-out. */
  workspaceId: string | null;
  resource?: AuditResource | null;
  /** Defaults to `success`. */
  outcome?: AuditOutcome;
  /** Free-form context. Redacted before it is stored; see {@link auditRow}. */
  detail?: Record<string, unknown>;
}

/** One row of `audit_log`, with every value already safe to persist. */
export interface AuditRow {
  workspaceId: string | null;
  actorSub: string;
  actorKind: "user" | "realm";
  action: AuditAction;
  resourceType: AuditResourceType | null;
  resourceId: string | null;
  outcome: AuditOutcome;
  requestId: string | null;
  detail: Record<string, unknown>;
}

/** A stored row as `/api/audit` returns it. */
export interface AuditEntry extends AuditRow {
  id: string;
  at: string;
}

/**
 * Keys whose value could be a query's result. Dropped, not redacted: there is
 * no shape of a metric value worth keeping in an audit row.
 */
const RESULT_KEY = /^(rows?|data|values|results?|records?)$/i;

function dropResults(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => dropResults(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = RESULT_KEY.test(k) ? REDACTED : dropResults(v, depth + 1);
  }
  return out;
}

/** Longest resource id kept. Real ids are far shorter. */
const MAX_RESOURCE_ID = 200;

function isIdentity(actor: AuditEvent["actor"]): actor is Identity {
  return !("kind" in actor);
}

/**
 * Turn an event into the row that will be written.
 *
 * Pure apart from reading the request context, and the single place redaction
 * happens: a test that feeds it a connection string and a result set and finds
 * neither in the output is a test of the table, not of one caller.
 */
export function auditRow(event: AuditEvent): AuditRow {
  const { actor } = event;
  const detail: Record<string, unknown> = { ...event.detail };
  // Acting through the platform-admin bypass is worth knowing on every row,
  // since nothing about the workspace explains why it was allowed.
  if (isIdentity(actor) && actor.platformAdmin) detail.platformAdmin = true;
  return {
    workspaceId: event.workspaceId,
    actorSub: actor.sub,
    actorKind: isIdentity(actor) ? "user" : actor.kind,
    action: event.action,
    resourceType: event.resource?.type ?? null,
    // Usually an id this app minted, but a chat's source id is whatever the
    // model wrote, so it is bounded and scrubbed like any other free text.
    resourceId:
      event.resource?.id === undefined
        ? null
        : redactString(event.resource.id).slice(0, MAX_RESOURCE_ID),
    outcome: event.outcome ?? "success",
    requestId: currentRequest()?.requestId ?? null,
    detail: redactFields(dropResults(detail) as Record<string, unknown>),
  };
}

/** How a row reaches storage. `insertAuditRow` in production; swapped in tests. */
export type AuditWriter = (row: AuditRow) => Promise<void>;

let writer: AuditWriter = insertAuditRow;

/**
 * Replace the writer, returning the restore. Tests only, in the same shape as
 * `setLogger`.
 */
export function setAuditWriter(next: AuditWriter): () => void {
  const previous = writer;
  writer = next;
  return () => {
    writer = previous;
  };
}

/** Record one event. Never throws, never waits; see the module comment. */
export function audit(event: AuditEvent): void {
  let row: AuditRow;
  try {
    row = auditRow(event);
  } catch (err) {
    recordAuditWriteFailure();
    log.error("audit.build_failed", { action: event.action, err });
    return;
  }
  let pending: Promise<void>;
  try {
    pending = writer(row);
  } catch (err) {
    pending = Promise.reject(err);
  }
  void pending.catch((err: unknown) => {
    recordAuditWriteFailure();
    log.error("audit.write_failed", { action: row.action, outcome: row.outcome, err });
  });
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

/** Rows per page when the caller does not ask, and the ceiling when it does. */
export const AUDIT_PAGE = 100;
export const AUDIT_MAX_PAGE = 500;

/** What `/api/audit` filters by, already parsed. */
export interface AuditQuery {
  /**
   * The workspaces to read. `null` means every row, global ones included,
   * and is only ever passed for a platform admin.
   */
  workspaceIds: string[] | null;
  from: Date | null;
  to: Date | null;
  action: AuditAction | null;
  outcome: AuditOutcome | null;
  /** Rows with an id below this one: the previous page's `next`. */
  before: bigint | null;
  limit: number;
}
