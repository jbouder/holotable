/**
 * An empty environment variable means "unset" (#350).
 *
 * `src/lib/config.ts` reads every value through `blank()`, so `OPENAI_BASE_URL=`
 * in a `.env` is the same as no line at all. The provider SDK does not share
 * that reading: `@ai-sdk/openai` looks `OPENAI_BASE_URL` up itself, at import,
 * and refuses the empty string, which took down every route that reaches
 * `src/lib/ai/provider.ts` on a checkout that had copied `.env.example`
 * verbatim. Dropping the empty values before any of that code loads is what
 * makes the config layer's promise hold for the dependencies too.
 *
 * Only the provider family is touched. Elsewhere an empty value can be a real
 * declaration: `SOURCE_SECRET_REFS=` means "no source may resolve a secret",
 * and `validateConfig` tells it from unset on purpose.
 *
 * Called where the environment is loaded and before anything reads it:
 * `src/instrumentation.ts` for the server, `scripts/lib/env.ts` for a CLI.
 */

/** The prefixes of the variables a dependency reads straight from the environment. */
export const PROVIDER_VARIABLE_PREFIXES = ["OPENAI_", "AI_"] as const;

/**
 * Delete every provider variable whose value is the empty string, and return
 * the names that were dropped, for a log line.
 */
export function unsetEmptyProviderVariables(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const dropped: string[] = [];
  for (const name of Object.keys(env)) {
    if (!PROVIDER_VARIABLE_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    if (env[name] !== "") continue;
    delete env[name];
    dropped.push(name);
  }
  return dropped.sort();
}
