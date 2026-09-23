import {
  formatConfigProblems,
  validateConfig,
  type ConfigProblem,
  type Environment,
} from "@/lib/config";
import {
  type SourceSecretUse,
  validateSecretsDir,
  validateSourceSecrets,
} from "@/lib/secrets/credentials";

/**
 * Startup checks, shared by `src/instrumentation.ts` (the Next 16 server
 * startup hook) and `scripts/config-check.ts` (`npm run config:check`).
 *
 * `validateConfig` is pure and covers the environment. This layer adds the
 * the checks that need the filesystem (`SOURCE_SECRETS_DIR`) and the
 * database (each live source's `secret_ref`, granted and resolving), and turns the combined result into a report and a verdict. Deciding what
 * to do with a failed verdict (exit, throw) is left to the caller.
 */

export interface StartupCheckOptions {
  env?: Environment;
  /** Validate as production. Defaults to `NODE_ENV === "production"`. */
  production?: boolean;
  /**
   * Load the `secret_ref` and workspace of every live source. Defaults to a
   * query against the config store; tests inject a stub. `null` skips the
   * check.
   */
  loadSecretRefs?: (() => Promise<SourceSecretUse[]>) | null;
}

export interface StartupCheckResult {
  ok: boolean;
  problems: ConfigProblem[];
  /** The full report, or `null` when there is nothing to say. */
  report: string | null;
}

/**
 * How long the source-credentials check may wait for the database. It runs
 * before the server accepts requests, so a database that is still starting
 * must not hold the boot hostage; the check degrades to a warning instead.
 */
const SECRET_REF_QUERY_TIMEOUT_MS = 5_000;

async function loadSecretRefsFromDatabase(): Promise<SourceSecretUse[]> {
  const { query } = await import("@/lib/db/pg");
  const rows = await query<{ secret_ref: string; workspace_id: string }>(
    "SELECT DISTINCT secret_ref, workspace_id FROM sources WHERE tombstoned_at IS NULL",
  );
  return rows.map((r) => ({ secretRef: r.secret_ref, workspaceId: r.workspace_id }));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * One line for a connection failure. `pg` surfaces a refused connection as an
 * `AggregateError` with an empty message and one entry per address tried, and
 * Node socket errors carry the useful part in `code`.
 */
function describeError(err: unknown): string {
  if (err instanceof AggregateError && err.errors.length > 0) {
    return describeError(err.errors[0]);
  }
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e?.code === "string" ? e.code : null;
  const message = typeof e?.message === "string" && e.message ? e.message : null;
  if (code && message && !message.includes(code)) return `${code}: ${message}`;
  return message ?? code ?? String(err);
}

export async function runStartupChecks(
  opts: StartupCheckOptions = {},
): Promise<StartupCheckResult> {
  const env = opts.env ?? process.env;
  const production = opts.production ?? env.NODE_ENV === "production";
  const problems = [...validateConfig(env, { production }), ...validateSecretsDir(env)];

  // Only ask the database when the URL is well-formed: a missing or malformed
  // DATABASE_URL is already reported above, and the query could only add noise.
  const databaseUsable =
    !!env.DATABASE_URL && !problems.some((p) => p.variable === "DATABASE_URL");
  const loader =
    opts.loadSecretRefs === undefined ? loadSecretRefsFromDatabase : opts.loadSecretRefs;
  if (loader && databaseUsable) {
    try {
      const refs = await withTimeout(loader(), SECRET_REF_QUERY_TIMEOUT_MS);
      problems.push(...validateSourceSecrets(refs, env));
    } catch (err) {
      problems.push({
        variable: "DATABASE_URL",
        message: `registered sources could not be read to check their credentials (${describeError(err)}); a source with an unconfigured secret_ref fails on Test instead.`,
        severity: "warning",
      });
    }
  }

  const ok = !problems.some((p) => p.severity === "error");
  return {
    ok,
    problems,
    report: problems.length > 0 ? formatConfigProblems(problems) : null,
  };
}
