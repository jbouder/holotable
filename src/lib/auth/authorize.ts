import { cookies } from "next/headers";
import { config } from "@/lib/config";
import { accessibleWorkspaces, hasWorkspaceRole, type Identity } from "@/lib/auth/claims";
import { verifySessionToken } from "@/lib/auth/session";
import { type ErrorKind, kindFromStatus, OPAQUE_MESSAGE } from "@/lib/errors";
import { amendRequest, currentRequest, log } from "@/lib/log";

/**
 * Centralized authorization.
 *
 * Every server request must be authorized here from the validated identity.
 * This is the ONLY place role decisions are made, and the ONLY place the
 * platform-admin global bypass is applied. Authorization is never derived from
 * a workspace id supplied in the request payload — callers pass the workspace
 * id resolved from a trusted, already-scoped resource (or from the identity).
 */

/**
 * Every action {@link can} decides. A runtime list rather than only a union so
 * the account page can describe each role by asking `can()` itself (#211),
 * which is what keeps that description from drifting from the rule.
 */
export const ACTIONS = [
  "dashboard:view",
  "dashboard:create",
  "dashboard:update",
  "dashboard:generate",
  "dashboard:delete",
  "source:manage",
  "source:use",
] as const;

export type Action = (typeof ACTIONS)[number];

export interface AuthzContext {
  workspaceId: string;
  /** Owner subject of the target resource, required for owner-gated actions. */
  ownerSub?: string;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Extra response headers, e.g. `Retry-After` on a 429. */
    public headers: Record<string, string> = {},
    /**
     * How the client should present this. Omitted means "whatever the status
     * implies" ({@link kindFromStatus}), which is right for the great majority
     * of throws; a route names it only when the status alone would mislead —
     * a failed statement is a `400`, but so is a malformed body.
     */
    public kind?: ErrorKind,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Pure authorization decision. Exported for unit testing. Platform admins are
 * globally authorized (the single sanctioned bypass).
 */
export function can(identity: Identity, action: Action, ctx: AuthzContext): boolean {
  if (identity.platformAdmin) return true;
  const { workspaceId, ownerSub } = ctx;

  switch (action) {
    case "dashboard:view":
    case "source:use":
      return hasWorkspaceRole(identity, workspaceId, "viewer");

    case "dashboard:create":
    case "dashboard:update":
    case "dashboard:generate":
      return hasWorkspaceRole(identity, workspaceId, "editor");

    case "dashboard:delete":
      // Owner of the dashboard, or a workspace source-admin (admin already
      // handled by the platform-admin bypass above).
      if (ownerSub && ownerSub === identity.sub) {
        return hasWorkspaceRole(identity, workspaceId, "viewer");
      }
      return hasWorkspaceRole(identity, workspaceId, "source-admin");

    case "source:manage":
      return hasWorkspaceRole(identity, workspaceId, "source-admin");

    default:
      return false;
  }
}

/**
 * The workspaces an identity may perform `action` in, optionally narrowed to a
 * single id.
 *
 * `only` is what a caller asked to see — a query-string filter — and it is a
 * FILTER, never a grant: the candidates come from the identity's own claims
 * and each survivor is still decided by {@link can}. An unknown or
 * unauthorized id therefore narrows the answer to nothing instead of widening
 * it, which is the shape a list endpoint needs (no membership is disclosed).
 */
export function authorizedWorkspaces(
  identity: Identity,
  action: Action,
  only?: string | null,
): string[] {
  return accessibleWorkspaces(identity).filter(
    (w) =>
      (only === undefined || only === null || w === only) &&
      can(identity, action, { workspaceId: w }),
  );
}

/** Read + verify the session cookie, returning the identity or null. */
export async function getIdentity(): Promise<Identity | null> {
  const store = await cookies();
  const token = store.get(config.sessionCookieName)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

/** Verify a token string directly (used by the SSE handler with NextRequest). */
export async function getIdentityFromToken(
  token: string | undefined,
): Promise<Identity | null> {
  if (!token) return null;
  return verifySessionToken(token);
}

/** Require an authenticated identity or throw 401. */
export async function requireIdentity(): Promise<Identity> {
  const identity = await getIdentity();
  if (!identity) throw new HttpError(401, "authentication required");
  // Attach the subject to every line this request writes from here on. Doing
  // it in the one function every authenticated route already calls is what
  // keeps handlers free of logging plumbing.
  amendRequest({ sub: identity.sub });
  return identity;
}

/** Assert the identity may perform the action, or throw 403. */
export function assertAuthorized(
  identity: Identity,
  action: Action,
  ctx: AuthzContext,
): void {
  amendRequest({ workspaceId: ctx.workspaceId });
  if (!can(identity, action, ctx)) {
    log.warn("authz.denied", { action, platformAdmin: identity.platformAdmin });
    throw new HttpError(403, `not authorized for ${action}`);
  }
}

/**
 * Convert a thrown HttpError (or unknown error) into a JSON Response.
 *
 * Every body carries `kind` so the client presents the error without inferring
 * it from the status, and the request id so a user reporting a failure has
 * something to quote that appears verbatim in the log. Neither widens what is
 * disclosed: the unhandled path still answers with {@link OPAQUE_MESSAGE} and
 * keeps the real cause in the log line below.
 */
export function errorResponse(err: unknown): Response {
  const requestId = currentRequest()?.requestId;
  if (err instanceof HttpError) {
    return Response.json(
      {
        error: err.message,
        kind: err.kind ?? kindFromStatus(err.status),
        requestId,
      },
      { status: err.status, headers: err.headers },
    );
  }
  // The message never reaches the caller — a 500 body says only the generic
  // sentence — so this line is the only record of what actually broke. The
  // request id on it is the one the caller was handed.
  log.error("request.unhandled_error", { err });
  return Response.json(
    { error: OPAQUE_MESSAGE, kind: "infrastructure", requestId },
    { status: 500 },
  );
}
