import { checkReadiness, readinessHttpStatus } from "@/lib/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Readiness probe: should this instance be sent traffic?
 *
 * Unlike `/api/health` this does I/O — a `SELECT 1` against the config store
 * and a cached reachability check of the realm JWKS — and it fails while the
 * process is draining (#47). The policy for which dependency is allowed to
 * fail the probe, and why the answer can never contain a connection string,
 * lives in `src/lib/readiness.ts`.
 *
 * No auth: a probe comes from the orchestrator, not from a signed-in user, and
 * the body is deliberately free of anything worth protecting.
 */
export async function GET(): Promise<Response> {
  const report = await checkReadiness();
  return Response.json(report, {
    status: readinessHttpStatus(report.status),
    headers: { "Cache-Control": "no-store" },
  });
}
