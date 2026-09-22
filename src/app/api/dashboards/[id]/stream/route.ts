import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { getDashboardById } from "@/lib/db/repo";
import { getPoller, type PollerEvent } from "@/lib/poller/registry";
import { TimeRange } from "@/lib/ir";
import { drainFrame } from "@/lib/sse";
import { onDrain } from "@/lib/shutdown";
import { route } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-Sent Events stream for a dashboard.
 *
 * Auth is via the session cookie (sent automatically by EventSource for
 * same-origin requests). Each subscriber is independently authorized here, then
 * attaches to the ONE shared in-process poller for this dashboard.
 */
export const GET = route(
  "dashboards.stream",
  async (req: Request, ctx: RouteContext<"/api/dashboards/[id]/stream">) => {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const dashboard = await getDashboardById(id);
    if (!dashboard) throw new HttpError(404, "dashboard not found");

    assertAuthorized(identity, "dashboard:view", {
      workspaceId: dashboard.workspaceId,
    });

    const url = new URL(req.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if ((from === null) !== (to === null)) {
      throw new HttpError(400, "both from and to time-range parameters are required");
    }
    const parsedRange = from && to ? TimeRange.safeParse({ from, to }) : undefined;
    if (parsedRange && !parsedRange.success) {
      throw new HttpError(400, "invalid time-range parameters");
    }
    const spec = parsedRange?.data
      ? { ...dashboard.spec, timeRange: parsedRange.data }
      : dashboard.spec;
    const poller = getPoller(id, dashboard.version, dashboard.workspaceId, spec);
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

        // Graceful shutdown (#47): hand the browser a reconnect delay before
        // the socket goes away, so it comes back to a healthy instance on a
        // spread-out timer instead of retrying into this one immediately. The
        // hook is unregistered on close, or the set would grow by one entry
        // for every connection the instance ever served.
        let unregisterDrain = () => {};

        const close = () => {
          unsubscribe();
          unregisterDrain();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };

        unregisterDrain = onDrain(() => {
          try {
            controller.enqueue(encoder.encode(drainFrame()));
          } catch {
            /* controller closed */
          }
          close();
        });

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
  },
);
