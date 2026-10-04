/**
 * Puts the process in demo mode before `src/lib/config.ts` loads, which reads
 * `AUTH_MODE` once at import. Import this first. node --test runs each file in
 * its own process, so it does not leak into other suites.
 */
process.env.AUTH_MODE = "demo";
process.env.DEMO_GROUPS = "/workspaces/demo/editor";
delete process.env.OIDC_JWKS_URL;
delete process.env.OIDC_ISSUER;
