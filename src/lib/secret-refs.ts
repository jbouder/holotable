import { z } from "zod";
import { type ApiError, apiErrorFromThrown, readApiError } from "@/lib/errors";

/**
 * `secret_ref`s, as a contract: how one is spelled, which workspaces may use
 * it, and what the server may say about it.
 *
 * A source names an env-var family and the server resolves the credentials
 * from it at execution time (`resolveCredentials` in `@/lib/secrets/credentials`).
 * Which families exist, and which workspace may use which, is the operator's
 * to declare in `SOURCE_SECRET_REFS` — see {@link parseSecretRefGrants}. A ref
 * the declaration does not grant to a source's workspace does not resolve,
 * whatever the environment holds: a source-admin in one workspace cannot
 * borrow another workspace's database role by typing its name.
 *
 * What crosses the wire is **the refs granted to the caller's workspace, each
 * with a boolean**, and nothing else: not the username, not a length, not a
 * hash, nothing derived from the password (invariant 5). The env-var *names*
 * are derived on whichever side needs them, from {@link secretRefEnvVars},
 * because they are a function of the ref rather than of anything secret.
 *
 * This module is imported by the browser, so it reads no environment and no
 * file; the server half lives in `@/lib/secrets/credentials`.
 */

/**
 * The spelling of a `secret_ref`: an UPPER_SNAKE env-var family.
 *
 * The single definition, shared by the draft schema, the grant declaration and
 * the credential resolver. Only names of this shape are ever looked up, and
 * only with the two suffixes below, so no arbitrary variable or file is
 * reachable through a ref.
 */
export const SECRET_REF_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export const SECRET_REF_MESSAGE = "secretRef must be an UPPER_SNAKE env family";

/**
 * The two environment variables — and, under `SOURCE_SECRETS_DIR`, the two
 * file names — a `secret_ref` resolves to.
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

/* -------------------------------------------------------------------------- */
/* Grants                                                                     */
/* -------------------------------------------------------------------------- */

/** The environment variable that declares which workspace may use which ref. */
export const SECRET_REF_GRANTS_VAR = "SOURCE_SECRET_REFS";

/** The workspace list that grants a ref to every workspace. */
export const ALL_WORKSPACES = "*";

/**
 * Which workspaces may use each ref: `"*"` for every workspace, or the set of
 * workspace ids. A ref that is not a key is granted to nobody.
 */
export type SecretRefGrants = ReadonlyMap<
  string,
  typeof ALL_WORKSPACES | ReadonlySet<string>
>;

export type SecretRefGrantsParse =
  | { ok: true; grants: SecretRefGrants }
  | { ok: false; error: string };

/** A workspace id as the grammar can carry it: no separator, no whitespace. */
const GRANT_WORKSPACE = /^[^\s:,;*]+$/;

/**
 * Parse a `SOURCE_SECRET_REFS` declaration.
 *
 * `TS_METRICS:demo,ops; BILLING_RO:finance; SHARED_RO:*` — entries separated
 * by `;` or a newline, each a ref, a colon, and a comma-separated workspace
 * list, where `*` alone grants the ref to every workspace. Whitespace around
 * any separator is ignored, so a Helm values file can put one entry per line.
 * The empty string is a valid declaration that grants nothing.
 *
 * Strict on purpose: a duplicate ref, an empty workspace list or `*` mixed
 * with names is refused rather than guessed at, because every one of them is
 * a typo that would otherwise grant more or less than the operator meant.
 */
export function parseSecretRefGrants(raw: string): SecretRefGrantsParse {
  const grants = new Map<string, typeof ALL_WORKSPACES | Set<string>>();
  const entries = raw
    .split(/[;\n]/)
    .map((e) => e.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const colon = entry.indexOf(":");
    if (colon === -1) {
      return {
        ok: false,
        error: `entry "${entry}" has no workspace list; write it as REF:workspace[,workspace…] or REF:*`,
      };
    }
    const ref = entry.slice(0, colon).trim();
    if (!SECRET_REF_PATTERN.test(ref)) {
      return {
        ok: false,
        error: `"${ref}" is not an UPPER_SNAKE secret_ref (in entry "${entry}")`,
      };
    }
    if (grants.has(ref)) {
      return { ok: false, error: `secret_ref "${ref}" is declared more than once` };
    }
    const workspaces = entry
      .slice(colon + 1)
      .split(",")
      .map((w) => w.trim());
    if (workspaces.length === 1 && workspaces[0] === ALL_WORKSPACES) {
      grants.set(ref, ALL_WORKSPACES);
      continue;
    }
    if (workspaces.includes(ALL_WORKSPACES)) {
      return {
        ok: false,
        error: `secret_ref "${ref}" mixes "*" with named workspaces; use "*" alone to grant every workspace`,
      };
    }
    if (workspaces.some((w) => !GRANT_WORKSPACE.test(w))) {
      return {
        ok: false,
        error: `secret_ref "${ref}" has an empty or malformed workspace in "${entry}"`,
      };
    }
    grants.set(ref, new Set(workspaces));
  }
  return { ok: true, grants };
}

/** Whether `grants` lets `workspaceId` use `secretRef`. Unknown means no. */
export function isGranted(
  grants: SecretRefGrants,
  secretRef: string,
  workspaceId: string,
): boolean {
  const granted = grants.get(secretRef);
  if (granted === undefined) return false;
  return granted === ALL_WORKSPACES || granted.has(workspaceId);
}

/** The refs `grants` lets `workspaceId` use, sorted. */
export function grantedRefs(grants: SecretRefGrants, workspaceId: string): string[] {
  return [...grants.keys()].filter((ref) => isGranted(grants, ref, workspaceId)).sort();
}

/* -------------------------------------------------------------------------- */
/* Readiness                                                                  */
/* -------------------------------------------------------------------------- */

/** One ref granted to the caller's workspace, and whether it resolves. */
export const GrantedSecretRef = z
  .object({
    ref: z.string().regex(SECRET_REF_PATTERN),
    configured: z.boolean(),
  })
  .strict();
export type GrantedSecretRef = z.infer<typeof GrantedSecretRef>;

/** The body `GET /api/secret-refs` answers with. */
export const GrantedSecretRefs = z.object({ refs: z.array(GrantedSecretRef) }).strict();
export type GrantedSecretRefs = z.infer<typeof GrantedSecretRefs>;

/** What the UI knows about one ref at any moment. */
export type SecretRefReadiness =
  | { state: "checking" }
  | { state: "configured"; ref: string }
  | { state: "missing"; ref: string; message: string }
  | { state: "not-granted"; ref: string; message: string }
  | { state: "error"; error: ApiError };

/** The granted list as the UI holds it while it is being fetched. */
export type GrantedSecretRefsState =
  | { state: "loading" }
  | { state: "ready"; refs: GrantedSecretRef[] }
  | { state: "error"; error: ApiError };

/**
 * The readiness of `secretRef` against the workspace's granted list.
 *
 * A ref absent from the list is not granted to this workspace — whether it is
 * declared for another workspace or not at all is deliberately not something
 * the list can tell, so neither can this.
 */
export function readinessIn(
  list: GrantedSecretRefsState,
  secretRef: string,
): SecretRefReadiness {
  if (list.state === "loading") return { state: "checking" };
  if (list.state === "error") return { state: "error", error: list.error };
  const entry = list.refs.find((r) => r.ref === secretRef);
  if (!entry) {
    return {
      state: "not-granted",
      ref: secretRef,
      message: `${secretRef} is not granted to this workspace, so this source cannot connect. An operator grants it in ${SECRET_REF_GRANTS_VAR}.`,
    };
  }
  if (entry.configured) return { state: "configured", ref: entry.ref };
  const env = secretRefEnvVars(entry.ref);
  return {
    state: "missing",
    ref: entry.ref,
    message: `No credentials on the server for ${entry.ref}. Set ${env.username} and ${env.password}, or save now and set them before the source is used.`,
  };
}

export type GrantedSecretRefsOutcome =
  | { ok: true; refs: GrantedSecretRef[] }
  | { ok: false; error: ApiError };

/**
 * Ask the server which refs this workspace may use.
 *
 * The workspace is on the query string because the route authorizes
 * `source:manage` against it — the same gate source creation passes, since
 * this answers a question only a prospective source author has any business
 * asking.
 */
export async function fetchGrantedSecretRefs(
  workspaceId: string,
  init?: { signal?: AbortSignal },
): Promise<GrantedSecretRefsOutcome> {
  const path = `/api/secret-refs?workspaceId=${encodeURIComponent(workspaceId)}`;
  try {
    const res = await fetch(path, { signal: init?.signal });
    if (!res.ok) return { ok: false, error: await readApiError(res) };
    const parsed = GrantedSecretRefs.safeParse(await res.json());
    return parsed.success
      ? { ok: true, refs: parsed.data.refs }
      : {
          ok: false,
          error: {
            error: "the credential reference list was malformed",
            kind: "unknown",
          },
        };
  } catch (err) {
    return { ok: false, error: apiErrorFromThrown(err) };
  }
}
