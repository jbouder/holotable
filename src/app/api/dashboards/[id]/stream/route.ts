import {
  requireIdentity,
  assertAuthorized,
  errorResponse,
  HttpError,
} from "@/lib/auth/authorize";
import { getDashboardById } from "@/lib/db/repo";
import { getPoller, type PollerEvent } from "@/lib/poller/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-Sent Events stream for a dashboard.
 *
 * Auth is via the session cookie (sent automatically by EventSource for
 * same-origin requests). Each subscriber is independently authorized here, then
 * attaches to the ONE shared in-process poller for this dashboard.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/dashboards/[id]/stream">) {
  try {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const dashboard = await getDashboardById(id);
    if (!dashboard) throw new HttpError(404, "dashboard not found");

    assertAuthorized(identity, "dashboard:view", {
      workspaceId: dashboard.workspaceId,
    });

    const poller = getPoller(id, dashboard.version, dashboard.spec);
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: PollerEvent) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            /* controller closed */
          }
        };
        // Prime the stream so the connection opens promptly.
        controller.enqueue(encoder.encode(": connected\n\n"));

        const unsubscribe = poller.subscribe(send);

        const close = () => {
          unsubscribe();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        req.signal.addEventListener("abort", close);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
