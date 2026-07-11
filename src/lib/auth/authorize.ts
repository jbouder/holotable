import { cookies } from "next/headers";
import { config } from "@/lib/config";
import { hasWorkspaceRole, type Identity } from "@/lib/auth/claims";
import { verifySessionToken } from "@/lib/auth/session";

/**
 * Centralized authorization.
 *
 * Every server request must be authorized here from the validated identity.
 * This is the ONLY place role decisions are made, and the ONLY place the
 * platform-admin global bypass is applied. Authorization is never derived from
 * a workspace id supplied in the request payload — callers pass the workspace
 * id resolved from a trusted, already-scoped resource (or from the identity).
 */

export type Action =
  | "dashboard:view"
  | "dashboard:create"
  | "dashboard:update"
  | "dashboard:generate"
  | "dashboard:delete"
  | "source:manage"
  | "source:use";

export interface AuthzContext {
  workspaceId: string;
  /** Owner subject of the target resource, required for owner-gated actions. */
  ownerSub?: string;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Pure authorization decision. Exported for unit testing. Platform admins are
 * globally authorized (the single sanctioned bypass).
 */
export function can(
  identity: Identity,
  action: Action,
  ctx: AuthzContext,
): boolean {
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
  return identity;
}

/** Assert the identity may perform the action, or throw 403. */
export function assertAuthorized(
  identity: Identity,
  action: Action,
  ctx: AuthzContext,
): void {
  if (!can(identity, action, ctx)) {
    throw new HttpError(403, `not authorized for ${action}`);
  }
}

/** Convert a thrown HttpError (or unknown error) into a JSON Response. */
export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  console.error("Unhandled error:", err);
  return Response.json({ error: "internal error" }, { status: 500 });
}
