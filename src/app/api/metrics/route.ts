import { route } from "@/lib/http";
import { authorizeMetricsRequest } from "@/lib/metrics-access";
import { metricsContentType, renderMetrics } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Prometheus scrape endpoint.
 *
 * Deliberately outside the session cookie: a scraper holds no session. Access
 * is decided by `src/lib/metrics-access.ts`, which keeps the endpoint closed
 * (404) until `METRICS_TOKEN` or `METRICS_ALLOWED_CIDRS` is configured.
 *
 * The body is the text exposition format straight from the registry. It is a
 * snapshot of counters already kept in memory, so it does no I/O and needs no
 * timeout of its own.
 */
export const GET = route(
  "metrics",
  async (req: Request): Promise<Response> => {
    const access = authorizeMetricsRequest(req);
    if (!access.allowed) {
      return Response.json(
        { error: access.message },
        {
          status: access.status,
          headers: {
            "Cache-Control": "no-store",
            // A 401 without this is not a well-formed challenge, and a scraper
            // that supports basic auth would otherwise retry with it.
            ...(access.status === 401
              ? { "WWW-Authenticate": 'Bearer realm="metrics"' }
              : {}),
          },
        },
      );
    }

    return new Response(await renderMetrics(), {
      headers: {
        "Content-Type": metricsContentType(),
        "Cache-Control": "no-store",
      },
    });
  },
  // Scraped every 15s; a refused scrape still logs at warn, which is the
  // signal an operator actually wants from this route.
  { quiet: true },
);
