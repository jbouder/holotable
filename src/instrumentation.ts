/**
 * Next 16 server startup hook. `register` runs once per server instance and
 * must finish before the first request is served, which makes it the place to
 * refuse a misconfigured boot.
 *
 * Two guards. `NEXT_RUNTIME`: the hook also runs for the edge runtime, where
 * neither `pg` nor `process.exit` exist. `NEXT_PHASE`: `next build` invokes
 * the hook while prerendering routes, with `NODE_ENV=production` and no
 * deployment environment; the build must keep succeeding with no `.env` at
 * all, so validation is a runtime concern only.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { runStartupChecks } = await import("@/lib/startup");
  const result = await runStartupChecks();
  if (result.report) {
    (result.ok ? console.warn : console.error)(result.report);
  }
  if (!result.ok) {
    // Throwing here surfaces as "An error occurred while loading
    // instrumentation hook" and Next aborts the start; exit explicitly as well
    // so the outcome does not depend on how the server was launched.
    process.exit(1);
  }
}
