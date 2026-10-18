/**
 * Puts the process in local mode (#600) before `src/lib/config.ts` loads,
 * which reads `AUTH_MODE` once at import. Import this first. node --test runs
 * each file in its own process, so it does not leak into other suites.
 */
process.env.AUTH_MODE = "local";
delete process.env.LOCAL_GROUPS;
delete process.env.OIDC_JWKS_URL;
delete process.env.OIDC_ISSUER;
delete process.env.OIDC_MCP_CLIENT_ID;
