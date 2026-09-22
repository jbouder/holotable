import { z } from "zod";
import { type ApiError, apiErrorFromThrown, readApiError } from "@/lib/errors";

/**
 * `secret_ref` readiness, as a contract.
 *
 * A source names an env-var family and the server resolves the credentials
 * from it at execution time (`resolveCredentials` in `@/lib/registry`). When
 * the operator has not set those variables the source still saves — it may be
 * configured before first use — and then fails on **Test** with a message the
 * author has no way to have anticipated. This module is what lets the UI say
 * so beforehand.
 *
 * What crosses the wire is a **boolean and the ref the caller already typed**,
 * and nothing else: not the username, not a length, not a hash, nothing
 * derived from the password (invariant 5). The env-var *names* are derived on
 * whichever side needs them, from {@link secretRefEnvVars}, because they are a
 * function of the ref rather than of anything secret.
 *
 * Readiness is a warning and never a gate: nothing here can refuse a save. The
 * variables belong to the operator and may well land after the source does, so
 * the form's job is to say what is missing, not to stand in the way.
 */

/**
 * The spelling of a `secret_ref`: an UPPER_SNAKE env-var family.
 *
 * The single definition, shared by the draft schema, the credential resolver
 * and the status route. It is what stops the route from being a way to ask
 * whether an arbitrary environment variable is set — only names of this shape
 * are ever looked up, and only with the two suffixes below.
 */
export const SECRET_REF_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export const SECRET_REF_MESSAGE = "secretRef must be an UPPER_SNAKE env family";

/**
 * The two environment variables a `secret_ref` resolves to.
 *
 * The resolver reads them and the UI names them when they are missing, so the
 * sentence the user is told to act on cannot drift from the lookup that
 * failed.
 */
export function secretRefEnvVars(secretRef: string): {
  username: string;
  password: string;
} {
  return { username: `${secretRef}_USERNAME`, password: `${secretRef}_PASSWORD` };
}

/** The body `GET /api/secret-refs/[ref]/status` answers with. */
export const SecretRefStatus = z
  .object({
    ref: z.string().regex(SECRET_REF_PATTERN),
    configured: z.boolean(),
  })
  .strict();
export type SecretRefStatus = z.infer<typeof SecretRefStatus>;

/**
 * What the form knows about a typed ref at any moment.
 *
 * `invalid` is decided on the client without asking — the pattern is the same
 * one the server enforces — so a half-typed ref does not produce a request per
 * keystroke.
 */
export type SecretRefReadiness =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "invalid"; message: string }
  | { state: "configured"; ref: string }
  | { state: "missing"; ref: string; message: string }
  | { state: "error"; error: ApiError };

/** The readiness a ref has before anything has been asked about it. */
export function readinessFor(secretRef: string): SecretRefReadiness {
  const ref = secretRef.trim();
  if (ref === "") return { state: "idle" };
  if (!SECRET_REF_PATTERN.test(ref))
    return { state: "invalid", message: SECRET_REF_MESSAGE };
  return { state: "checking" };
}

/** The readiness a status body describes. */
export function readinessFromStatus(status: SecretRefStatus): SecretRefReadiness {
  if (status.configured) return { state: "configured", ref: status.ref };
  const env = secretRefEnvVars(status.ref);
  return {
    state: "missing",
    ref: status.ref,
    message: `No credentials on the server for ${status.ref}. Set ${env.username} and ${env.password}, or save now and set them before the source is used.`,
  };
}

export type SecretRefStatusOutcome =
  | { ok: true; status: SecretRefStatus }
  | { ok: false; error: ApiError };

/**
 * Ask the server whether it holds credentials for `secretRef`.
 *
 * The workspace is on the query string because the route authorizes
 * `source:manage` against it — the same gate source creation passes, since
 * this answers a question only a prospective source author has any business
 * asking.
 */
export async function fetchSecretRefStatus(
  input: { workspaceId: string; secretRef: string },
  init?: { signal?: AbortSignal },
): Promise<SecretRefStatusOutcome> {
  const path = `/api/secret-refs/${encodeURIComponent(input.secretRef)}/status?workspaceId=${encodeURIComponent(input.workspaceId)}`;
  try {
    const res = await fetch(path, { signal: init?.signal });
    if (!res.ok) return { ok: false, error: await readApiError(res) };
    const parsed = SecretRefStatus.safeParse(await res.json());
    return parsed.success
      ? { ok: true, status: parsed.data }
      : {
          ok: false,
          error: { error: "the readiness result was malformed", kind: "unknown" },
        };
  } catch (err) {
    return { ok: false, error: apiErrorFromThrown(err) };
  }
}
