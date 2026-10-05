import {
  requireIdentity,
  assertAuthorized,
  can,
  getSessionToken,
  HttpError,
} from "@/lib/auth/authorize";
import { tokenExpiry, tokenRef, verifySessionToken } from "@/lib/auth/session";
import { shareSessionId } from "@/lib/auth/share";
import { resolveShare } from "@/lib/auth/share-access";
import { guardStream, type StreamEnd } from "@/lib/auth/stream-guard";
import { config } from "@/lib/config";
import { getDashboardById, getSourceById } from "@/lib/db/repo";
import { rowScopeFor } from "@/lib/row-scope";
import { defaultPanelExecutor, getPoller, type PollerEvent } from "@/lib/poller/registry";
import { selectionFromParams } from "@/lib/variable-selection";
import { checkedSelection, variableSourceIds } from "@/lib/variables";
import { hasQuery, TimeRange } from "@/lib/ir";
import {
  accessEndedFrame,
  drainFrame,
  eventFrame,
  HEARTBEAT_FRAME,
  HEARTBEAT_MS,
  sessionEndedFrame,
  sessionExpiredFrame,
} from "@/lib/sse";
import { onDrain } from "@/lib/shutdown";
import { route } from "@/lib/http";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const END_FRAMES: Record<StreamEnd, () => string> = {
  expired: sessionExpiredFrame,
  revoked: sessionEndedFrame,
  forbidden: accessEndedFrame,
};

/**
 * Server-Sent Events stream for a dashboard.
 *
 * Auth is via the session cookie (sent automatically by EventSource for
 * same-origin requests). Each subscriber is independently authorized here, then
 * attaches to the ONE shared in-process poller for this dashboard, and stays
 * authorized only as long as the session it connected with (#32,
 * `lib/auth/stream-guard.ts`).
 */
export const GET = route(
  "dashboards.stream",
  async (req: Request, ctx: RouteContext<"/api/dashboards/[id]/stream">) => {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    // A read-only share link (#65) streams with its token instead of a
    // session: an identity that `can()` lets view this one dashboard and
    // nothing else. This route and the embed page are the only places a
    // share token is accepted. An unusable one reads as a missing dashboard.
    const shareToken = url.searchParams.get("share");
    const shared = shareToken === null ? null : await resolveShare(shareToken, id);
    if (shareToken !== null && !shared) throw new HttpError(404, "dashboard not found");
    const identity = shared ? shared.identity : await requireIdentity();
    // A service-account token (#288) calls the API; it does not watch. The
    // stream's guard re-verifies a session, which a token is not.
    if (identity.serviceAccount) {
      throw new HttpError(403, "a service-account token cannot open a dashboard stream");
    }
    // Kept to verify again while the stream is open (#32), and to match a
    // back-channel logout against (#28). Verified by `requireIdentity` above.
    const token = shared ? null : await getSessionToken();
    const dashboard = await getDashboardById(id);
    if (!dashboard) throw new HttpError(404, "dashboard not found");

    assertAuthorized(
      identity,
      "dashboard:view",
      { workspaceId: dashboard.workspaceId, dashboardId: id },
      { type: "dashboard", id },
    );

    const from = shared ? null : url.searchParams.get("from");
    const to = shared ? null : url.searchParams.get("to");
    if ((from === null) !== (to === null)) {
      throw new HttpError(400, "both from and to time-range parameters are required");
    }
    const parsedRange = from && to ? TimeRange.safeParse({ from, to }) : undefined;
    if (parsedRange && !parsedRange.success) {
      throw new HttpError(400, "invalid time-range parameters");
    }
    // A share shows its own fixed window when it has one, and never one the
    // holder of the link picks.
    const range = shared ? (shared.share.timeRange ?? undefined) : parsedRange?.data;
    const spec = range ? { ...dashboard.spec, timeRange: range } : dashboard.spec;
    // The viewer's row-filter claim values for this dashboard's filtered
    // sources (#31), which pick the poller: viewers who would see the same
    // rows share one, and no one is handed another tenant's poller. Sources
    // outside the dashboard's workspace are left out here and refused by the
    // executor, as they always were.
    const sources = (
      await Promise.all(
        [
          ...new Set([
            ...spec.panels.filter(hasQuery).map((p) => p.query.sourceId),
            // A query variable's source narrows its values to the viewer's
            // rows as well (#67).
            ...variableSourceIds(spec.variables),
          ]),
        ].map((s) => getSourceById(s)),
      )
    ).filter(
      (s): s is NonNullable<typeof s> =>
        s !== null && !s.tombstonedAt && s.workspaceId === dashboard.workspaceId,
    );
    const scope = rowScopeFor(identity, sources);
    // The viewer's variable picks (#67), each checked against what its
    // variable allows this viewer before anything runs with it.
    const variables = await checkedSelection(
      spec.variables,
      // A share link runs every variable at its default.
      shared ? {} : selectionFromParams(url.searchParams),
      dashboard.workspaceId,
      scope,
    );
    const poller = getPoller(
      id,
      dashboard.version,
      dashboard.workspaceId,
      spec,
      scope,
      defaultPanelExecutor,
      variables,
    );
    // Where the browser got to before it lost the stream (#43). `EventSource`
    // sends the header itself when it reconnects; a page that builds a new
    // one passes it in the query. Untrusted, and decoded by the poller, which
    // falls back to a full snapshot on anything it does not like.
    const resumeToken =
      req.headers.get("last-event-id") ?? url.searchParams.get("lastEventId");
    // Opening the stream is when this viewer's statements start running, so
    // it is the execution the audit log records (#30): each panel's source
    // and a digest of its statement, at the version that will run. The
    // poller's refreshes are the same statements on a timer and are not
    // recorded one by one. A resume is recorded too, since it is a new
    // authorization; `resumed` tells it apart.
    audit({
      actor: identity,
      action: "dashboard.stream",
      workspaceId: dashboard.workspaceId,
      resource: { type: "dashboard", id },
      detail: {
        version: dashboard.version,
        timeRange: spec.timeRange,
        variables,
        resumed: resumeToken !== null,
        queries: spec.panels.filter(hasQuery).map((p) => ({
          panelId: p.id,
          sourceId: p.query.sourceId,
          sql: p.query.sql,
        })),
      },
    });
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
        let stopGuard = () => {};

        const close = () => {
          clearInterval(heartbeat);
          unsubscribe();
          unregisterDrain();
          stopGuard();
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

        // The stream is authorized above, once; this keeps it authorized
        // only while the session is (#32): it ends at the token's expiry, on
        // a back-channel logout of this session (#28), and when a periodic
        // re-check finds the dashboard gone or no longer viewable. Only this
        // subscriber is closed; the others on the same poller carry on.
        // A share's stream ends at the share's expiry, at once on its
        // revocation (the revoke route names it by `shareSessionId`), and
        // when the re-check finds it revoked or the dashboard gone; each as
        // `access-ended`, since there is no session to renew.
        stopGuard = guardStream({
          expiresAt: shared
            ? Date.parse(shared.share.expiresAt)
            : token
              ? tokenExpiry(token)
              : null,
          ref: shared
            ? { sub: identity.sub, sid: shareSessionId(shared.share.id), iat: 0 }
            : token
              ? tokenRef(token)
              : null,
          intervalMs: config.sseReauthIntervalMs,
          verify: async () =>
            shared
              ? ((await resolveShare(shareToken, id))?.identity ?? null)
              : token
                ? verifySessionToken(token)
                : null,
          authorize: async (who) => {
            const latest = await getDashboardById(id);
            return (
              latest !== null &&
              can(who, "dashboard:view", {
                workspaceId: latest.workspaceId,
                dashboardId: id,
              })
            );
          },
          onEnd: (why) => {
            try {
              const frame = shared ? accessEndedFrame : END_FRAMES[why];
              controller.enqueue(encoder.encode(frame()));
            } catch {
              /* controller closed */
            }
            close();
          },
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
