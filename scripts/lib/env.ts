import { loadEnvConfig } from "@next/env";

/**
 * Load `.env*` into `process.env` for a CLI script, the way `next dev` and
 * `next start` do for the server.
 *
 * Import this for its side effect, first, before anything that reads the
 * environment: `smoke` reaches `src/lib/` modules that read it at import time,
 * so loading it from `main()` would be too late.
 *
 * `loadEnvConfig` never overwrites a variable that is already set, so the
 * compose services and CI, which pass their configuration in the environment,
 * behave exactly as before. A missing `.env` is not an error — the Docker
 * `migrate` target and CI have none.
 */
export function loadScriptEnv(): void {
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
}

loadScriptEnv();
