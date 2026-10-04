/**
 * Carries a `tenant` claim into sessions before `src/lib/config.ts` loads,
 * which reads `ROW_FILTER_CLAIMS` once at import (#31). Import this first.
 * node --test runs each file in its own process, so it does not leak.
 */
process.env.ROW_FILTER_CLAIMS = "tenant";
