import { HttpError } from "@/lib/auth/authorize";
import { SecretRefError, assertSecretRefGranted } from "@/lib/secrets/credentials";

/**
 * Refuse, as a 400, a `secret_ref` the caller's workspace is not granted.
 *
 * For the routes that save or introspect with a ref (create, update,
 * discover), so an author learns at the form rather than on first query. It
 * is not the enforcement point — `resolveCredentials` checks the grant again
 * on every connection — only the earliest place the answer is useful.
 *
 * Kept apart from `@/lib/secrets/credentials` so the resolver does not pull
 * the request-scoped auth module into scripts that execute queries.
 */
export function requireGrantedSecretRef(secretRef: string, workspaceId: string): void {
  try {
    assertSecretRefGranted(secretRef, workspaceId);
  } catch (err) {
    if (err instanceof SecretRefError) throw new HttpError(400, err.message);
    throw err;
  }
}
