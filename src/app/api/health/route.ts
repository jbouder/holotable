import { appCommit, appVersion } from "@/lib/version";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness probe: the Dockerfile `HEALTHCHECK` and, later, the orchestrator
 * (#56) hit this to learn that the process is up and serving requests.
 *
 * Deliberately unconditional — no auth, no I/O, nothing that can be slow or
 * flaky — so a healthy process never reports otherwise. Whether the process
 * can *do* anything (database reachable, Keycloak reachable) is a readiness
 * question and belongs to `/api/ready`.
 *
 * The build identity rides along because this is the one endpoint that always
 * answers: it tells an operator which build is running without a shell in the
 * container. Both values name a public artifact of the build, never a secret.
 */
export function GET(): Response {
  return Response.json(
    { status: "ok", version: appVersion, commit: appCommit },
    { headers: { "Cache-Control": "no-store" } },
  );
}
