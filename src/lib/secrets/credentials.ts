import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ConfigProblem, Environment } from "@/lib/config";
import {
  type GrantedSecretRef,
  type SecretRefGrants,
  SECRET_REF_GRANTS_VAR,
  SECRET_REF_PATTERN,
  grantedRefs,
  isGranted,
  parseSecretRefGrants,
  secretRefEnvVars,
} from "@/lib/secret-refs";

/**
 * Source credential resolution — the one place a `secret_ref` becomes a
 * username and a password.
 *
 * Two rules, in this order, on every resolution:
 *
 * 1. **The ref must be granted to the source's workspace** by
 *    `SOURCE_SECRET_REFS`. Unset or malformed grants nothing: this fails
 *    closed, so a missing declaration can only stop a source, never widen
 *    one. The check runs here, where credentials are used, and not only at
 *    the route that saved the source — a record written some other way, or
 *    a declaration narrowed since, is refused all the same.
 * 2. **The credentials come from `SOURCE_SECRETS_DIR` first, then the
 *    environment.** Files are read per resolution, so a Kubernetes Secret
 *    mounted as a volume — which the kubelet refreshes in place — adds or
 *    rotates a source's credentials with no restart. The environment is
 *    fixed at process start and stays the fallback.
 *
 * Credentials are never stored and never cached here; a caller holds them only
 * for the connection it is opening. Node-only (`node:fs`), which is why it is
 * not in `@/lib/registry`: that module is also bundled for the browser.
 */

export interface SourceCredentials {
  username: string;
  password: string;
}

/** The environment variable naming the directory credential files are read from. */
export const SECRETS_DIR_VAR = "SOURCE_SECRETS_DIR";

/**
 * A `secret_ref` did not resolve: not granted, not configured, or unreadable.
 * The message names the ref, the workspace and the variable to fix — never a
 * credential — so routes may show it to the source author as it stands.
 */
export class SecretRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretRefError";
  }
}

let parsedGrants: { raw: string | undefined; grants: SecretRefGrants } | null = null;

/**
 * The grants the environment declares. A malformed declaration grants nothing
 * here; `validateConfig` is what reports it, as an error, at boot.
 */
export function secretRefGrants(env: Environment = process.env): SecretRefGrants {
  const raw = env[SECRET_REF_GRANTS_VAR];
  if (parsedGrants !== null && parsedGrants.raw === raw) return parsedGrants.grants;
  const parsed = raw === undefined ? null : parseSecretRefGrants(raw);
  const grants: SecretRefGrants = parsed?.ok ? parsed.grants : new Map();
  parsedGrants = { raw, grants };
  return grants;
}

/** Refuse a ref that is malformed or not granted to `workspaceId`. */
export function assertSecretRefGranted(
  secretRef: string,
  workspaceId: string,
  env: Environment = process.env,
): void {
  if (!SECRET_REF_PATTERN.test(secretRef)) {
    throw new SecretRefError(`invalid secret_ref "${secretRef}"`);
  }
  if (!isGranted(secretRefGrants(env), secretRef, workspaceId)) {
    throw new SecretRefError(
      `secret_ref "${secretRef}" is not granted to workspace "${workspaceId}"; an operator grants it in ${SECRET_REF_GRANTS_VAR}`,
    );
  }
}

/**
 * Resolve the credentials for a source's `secret_ref`.
 *
 * `secret_ref` "TS_METRICS" in a workspace it is granted to resolves
 * `TS_METRICS_USERNAME` / `TS_METRICS_PASSWORD` — as files in
 * `SOURCE_SECRETS_DIR` when both are there, otherwise from the environment.
 * The read-only user is expected here; execution never uses a privileged user.
 */
export function resolveCredentials(
  secretRef: string,
  workspaceId: string,
  env: Environment = process.env,
): SourceCredentials {
  assertSecretRefGranted(secretRef, workspaceId, env);

  const fromFiles = credentialsFromFiles(secretRef, env);
  if (fromFiles) return fromFiles;

  const names = secretRefEnvVars(secretRef);
  const username = env[names.username];
  const password = env[names.password];
  if (!username || password === undefined) {
    const where = env[SECRETS_DIR_VAR]
      ? ` as files in ${SECRETS_DIR_VAR} or in the environment`
      : " in the environment";
    throw new SecretRefError(
      `credentials for secret_ref "${secretRef}" are not configured on the server; set ${names.username} and ${names.password}${where}`,
    );
  }
  return { username, password };
}

/**
 * Whether `secretRef` resolves for `workspaceId` — a boolean, and only a
 * boolean. It is deliberately the *same* call an execution makes rather than
 * a second opinion about the environment, so what the UI reports and what a
 * query meets cannot diverge.
 */
export function hasCredentials(
  secretRef: string,
  workspaceId: string,
  env: Environment = process.env,
): boolean {
  try {
    resolveCredentials(secretRef, workspaceId, env);
    return true;
  } catch {
    return false;
  }
}

/** The refs granted to `workspaceId`, each with whether it resolves. */
export function grantedSecretRefStatus(
  workspaceId: string,
  env: Environment = process.env,
): GrantedSecretRef[] {
  return grantedRefs(secretRefGrants(env), workspaceId).map((ref) => ({
    ref,
    configured: hasCredentials(ref, workspaceId, env),
  }));
}

/**
 * Both files, neither (fall through to the environment), or a refusal. Half a
 * pair is refused rather than completed from the environment: a username from
 * one place and a password from another is never what the operator meant.
 */
function credentialsFromFiles(
  secretRef: string,
  env: Environment,
): SourceCredentials | null {
  const dir = env[SECRETS_DIR_VAR];
  if (!dir) return null;
  const names = secretRefEnvVars(secretRef);
  const username = readCredentialFile(dir, names.username);
  const password = readCredentialFile(dir, names.password);
  if (username === undefined && password === undefined) return null;
  if (!username || password === undefined) {
    throw new SecretRefError(
      `credentials for secret_ref "${secretRef}" are incomplete in ${SECRETS_DIR_VAR}: both ${names.username} and ${names.password} must be present`,
    );
  }
  return { username, password };
}

/**
 * One credential file, or `undefined` when it is not there. A single trailing
 * newline is dropped — `echo pw > file` and most secret tooling add one, and a
 * password that genuinely ends in a newline is not a thing anyone configures.
 * The name is built from an UPPER_SNAKE ref and a fixed suffix, so it cannot
 * leave the directory.
 */
function readCredentialFile(dir: string, name: string): string | undefined {
  try {
    return readFileSync(path.join(dir, name), "utf8").replace(/\r?\n$/, "");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new SecretRefError(
      `could not read ${name} from ${SECRETS_DIR_VAR} (${code ?? "unknown error"})`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Startup checks                                                             */
/* -------------------------------------------------------------------------- */

/** A live source, as far as the startup check needs to know it. */
export interface SourceSecretUse {
  secretRef: string;
  workspaceId: string;
}

/**
 * Check that every live source's `secret_ref` is granted to its workspace and
 * resolves. Always warnings: sources are created at runtime, and a source
 * whose credentials arrive with the next deploy should not keep the whole
 * server from starting. The same failure still surfaces on Test and on
 * execution.
 */
export function validateSourceSecrets(
  sources: Iterable<SourceSecretUse>,
  env: Environment = process.env,
): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const grants = secretRefGrants(env);
  const reported = new Set<string>();

  for (const { secretRef, workspaceId } of sources) {
    const key = `${secretRef}\u0000${workspaceId}`;
    if (reported.has(key)) continue;
    reported.add(key);

    if (!isGranted(grants, secretRef, workspaceId)) {
      problems.push({
        variable: SECRET_REF_GRANTS_VAR,
        message: `does not grant secret_ref "${secretRef}" to workspace "${workspaceId}"; its sources there will fail on Test and on every query until it does.`,
        severity: "warning",
      });
      continue;
    }
    // One report per ref, however many workspaces share it.
    if (reported.has(secretRef)) continue;
    reported.add(secretRef);
    try {
      resolveCredentials(secretRef, workspaceId, env);
    } catch (err) {
      problems.push({
        variable: secretRefEnvVars(secretRef).username,
        message: `${err instanceof Error ? err.message : String(err)}. A registered source uses it and will fail on Test and on every query until it resolves.`,
        severity: "warning",
      });
    }
  }
  return problems;
}

/**
 * A `SOURCE_SECRETS_DIR` that is not a directory is almost always a mount path
 * that does not match the volume. A warning, not a refusal: resolution falls
 * back to the environment, which may be exactly what is intended meanwhile.
 */
export function validateSecretsDir(env: Environment = process.env): ConfigProblem[] {
  const dir = env[SECRETS_DIR_VAR];
  if (!dir) return [];
  try {
    if (statSync(dir).isDirectory()) return [];
  } catch {
    // Reported below.
  }
  return [
    {
      variable: SECRETS_DIR_VAR,
      message: `is "${dir}", which is not a readable directory; source credentials will be read from the environment only. Check the volume's mountPath.`,
      severity: "warning",
    },
  ];
}
