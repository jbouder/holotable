import { authorizedWorkspaces, HttpError } from "@/lib/auth/authorize";
import type { Identity } from "@/lib/auth/claims";
import {
  AUDIT_ACTIONS,
  AUDIT_MAX_PAGE,
  AUDIT_OUTCOMES,
  AUDIT_PAGE,
  type AuditAction,
  type AuditOutcome,
  type AuditQuery,
} from "@/lib/audit";
import { resolveTimeExpr, TimeRangeError } from "@/lib/time";

/**
 * Who may read which audit rows, and `/api/audit`'s query string as an
 * {@link AuditQuery}. Separate from `audit.ts` because `authorize.ts` writes
 * through that module and this one reads through `authorize.ts`.
 */

/**
 * The workspaces whose rows `identity` may read, narrowed to `requested`.
 *
 * A workspace source-admin reads the workspaces they administer, and
 * `?workspaceId=` is a filter on those, never a grant: an id outside them
 * matches nothing, so membership is not disclosed. A platform admin may read
 * any workspace, and with no filter reads every row, including the sign-ins
 * and sign-outs that belong to no workspace (`null`). Anyone else gets `[]`.
 */
export function auditScope(
  identity: Identity,
  requested: string | null,
): string[] | null {
  if (identity.platformAdmin) return requested ? [requested] : null;
  return authorizedWorkspaces(identity, "source:manage", requested);
}

function oneOf<T extends string>(
  list: readonly T[],
  raw: string | null,
  name: string,
): T | null {
  if (raw === null || raw === "") return null;
  if ((list as readonly string[]).includes(raw)) return raw as T;
  throw new HttpError(400, `unknown ${name}: ${raw.slice(0, 64)}`);
}

function time(raw: string | null, name: string, now: Date): Date | null {
  if (raw === null || raw === "") return null;
  try {
    return resolveTimeExpr(raw, now);
  } catch (err) {
    if (err instanceof TimeRangeError) {
      throw new HttpError(400, `${name} must be an ISO timestamp or like "now-1h"`);
    }
    throw err;
  }
}

/** A `?limit=` as a row count. Anything unusable is the default. */
export function auditLimit(raw: string | null): number {
  const n = Number(raw);
  if (raw === null || raw === "" || !Number.isFinite(n) || n < 1) return AUDIT_PAGE;
  return Math.min(Math.floor(n), AUDIT_MAX_PAGE);
}

/**
 * Parse the query string. A filter that is present but unusable is a 400
 * rather than being ignored: dropping a filter someone asked for would answer
 * a broader question than the one they asked.
 */
export function parseAuditQuery(
  identity: Identity,
  params: URLSearchParams,
  now: Date = new Date(),
): AuditQuery {
  const from = time(params.get("from"), "from", now);
  const to = time(params.get("to"), "to", now);
  if (from && to && from.getTime() >= to.getTime()) {
    throw new HttpError(400, "from must be before to");
  }
  const before = params.get("before");
  if (before !== null && !/^[1-9][0-9]{0,18}$/.test(before)) {
    throw new HttpError(400, "before must be the next value from a previous page");
  }
  return {
    workspaceIds: auditScope(identity, params.get("workspaceId") || null),
    from,
    to,
    action: oneOf<AuditAction>(AUDIT_ACTIONS, params.get("action"), "action"),
    outcome: oneOf<AuditOutcome>(AUDIT_OUTCOMES, params.get("outcome"), "outcome"),
    before: before === null ? null : BigInt(before),
    limit: auditLimit(params.get("limit")),
  };
}
