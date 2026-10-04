import {
  requireIdentity,
  assertAuthorized,
  getSessionRef,
  HttpError,
} from "@/lib/auth/authorize";
import { isRevoked, onRevoke } from "@/lib/auth/revocation";
import { getDashboardById } from "@/lib/db/repo";
import { getPoller, type PollerEvent } from "@/lib/poller/registry";
import { TimeRange } from "@/lib/ir";
import {
  drainFrame,
  eventFrame,
  HEARTBEAT_FRAME,
  HEARTBEAT_MS,
  sessionEndedFrame,
} from "@/lib/sse";
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
    // What a back-channel logout would name this subscriber by (#28).
    const session = await getSessionRef();
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
    // Where the browser got to before it lost the stream (#43). `EventSource`
    // sends the header itself when it reconnects; a page that builds a new
    // one passes it in the query. Untrusted, and decoded by the poller, which
    // falls back to a full snapshot on anything it does not like.
    const resumeToken =
      req.headers.get("last-event-id") ?? url.searchParams.get("lastEventId");
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (frame: string) => {
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            /* controller closed */
          }
        };
        const send = (event: PollerEvent, eventId?: string) => {
          write(eventFrame(JSON.stringify(event), eventId));
        };
        // Prime the stream so the connection opens promptly.
        write(": connected\n\n");

        const unsubscribe = poller.subscribe(send, resumeToken);
        // A comment every so often, so a proxy that closes quiet connections
        // does not close one whose dashboard refreshes slowly (#43).
        const heartbeat = setInterval(() => write(HEARTBEAT_FRAME), HEARTBEAT_MS);

        // Graceful shutdown (#47): hand the browser a reconnect delay before
        // the socket goes away, so it comes back to a healthy instance on a
        // spread-out timer instead of retrying into this one immediately. The
        // hook is unregistered on close, or the set would grow by one entry
        // for every connection the instance ever served.
        let unregisterDrain = () => {};
        let unregisterRevoke = () => {};

        const close = () => {
          clearInterval(heartbeat);
          unsubscribe();
          unregisterDrain();
          unregisterRevoke();
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

        // Back-channel logout (#28): a stream is authorized once, when it
        // opens, so a session the realm ends would otherwise keep receiving
        // until the socket happened to drop. Every revocation is checked
        // against this stream's session; only a match closes it, so the
        // other subscribers on the same poller carry on.
        unregisterRevoke = onRevoke(() => {
          if (!session || !isRevoked(session)) return;
          try {
            controller.enqueue(encoder.encode(sessionEndedFrame()));
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
