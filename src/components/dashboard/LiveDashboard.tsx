"use client";

import * as React from "react";
import { Pause, Play } from "lucide-react";
import type { Dashboard, TimeRange } from "@/lib/ir";
import type { PollerEvent } from "@/lib/poller/registry";
import { DashboardGrid } from "@/components/dashboard/DashboardGrid";
import { PanelView, type PanelState } from "@/components/dashboard/PanelView";
import { ErrorDisplay } from "@/components/ui/error-display";
import type { ApiError } from "@/lib/errors";
import { ConnectionIndicator } from "@/components/dashboard/ConnectionIndicator";
import { NavPortal } from "@/components/nav-slot";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TimeRangeFilter } from "@/components/dashboard/TimeRangeFilter";
import {
  type ConnectionSignal,
  type ConnectionStatus,
  INITIAL_CONNECTION,
  reduceConnection,
} from "@/lib/connection";
import {
  ACCESS_ENDED_EVENT,
  DRAIN_EVENT,
  SESSION_ENDED_EVENT,
  SESSION_EXPIRED_EVENT,
} from "@/lib/sse";
import { ensureSession, renewSession } from "@/lib/session-renewal";
import { mergePanelRows } from "@/lib/stream-merge";
import { HIDDEN_STREAM_GRACE_MS } from "@/lib/stream-idle";
import { isRolling, rangeSearch } from "@/lib/time-range";
import { Notice } from "@/components/notice";
import { useHiddenFor, useIdle } from "@/components/dashboard/use-stream-idle";

/**
 * A panel that was live is now only as fresh as its last frame. Used on a
 * transport error, on the server's drain frame, and by the watchdog.
 *
 * `updatedAt` is deliberately left alone: it records when the data arrived, and
 * going stale does not change that. It is what the panel's tooltip reports.
 */
function markStale(prev: Record<string, PanelState>): Record<string, PanelState> {
  const out: Record<string, PanelState> = {};
  for (const [k, v] of Object.entries(prev)) {
    out[k] = v.status === "live" ? { ...v, status: "stale" } : v;
  }
  return out;
}

/**
 * Live dashboard viewer.
 *
 * Opens exactly ONE EventSource for the whole dashboard (SSE authenticated via
 * the session cookie, sent automatically for same-origin requests) and fans
 * events out to per-panel state. Appended deltas are merged into a bounded
 * rolling window; PanelView applies them via ECharts setOption without
 * recreating charts. A panel becomes "stale" if no tick arrives within roughly
 * two refresh intervals.
 *
 * Connection state is tracked separately from panel state, in the reducer in
 * `lib/connection.ts`: `EventSource` retries forever and says nothing, so
 * without it a dead stream and a paused one are the same grey dot.
 *
 * The stream is closed while nobody is looking (#263, `lib/stream-idle.ts`):
 * a tab hidden past a grace period suspends it until the tab is shown, and
 * with `idlePauseMs` (demo mode) a visible tab nobody touches is paused.
 */
export function LiveDashboard({
  dashboardId,
  spec,
  maxWindowPoints,
  initialTimeRange,
  header,
  actions,
  empty,
  idlePauseMs,
}: {
  dashboardId: string;
  spec: Dashboard;
  maxWindowPoints: number;
  /**
   * The window to open on, from the URL. The server validated it against the
   * IR and fell back to the spec's own range, so this is always a window the
   * stream route will accept.
   */
  initialTimeRange?: TimeRange;
  header?: React.ReactNode;
  actions?: React.ReactNode;
  /** Shown in place of the grid when the spec carries no panels. */
  empty?: React.ReactNode;
  /**
   * Pause live updates after this long without interaction. Set in demo mode
   * only, so an abandoned tab lets the demo's container sleep; undefined
   * never pauses a visible tab.
   */
  idlePauseMs?: number;
}) {
  const [states, setStates] = React.useState<Record<string, PanelState>>({});
  const [live, setLive] = React.useState(true);
  // Set when the idle timer, not the user, paused the stream, so the page can
  // say why the numbers stopped.
  const [idlePaused, setIdlePaused] = React.useState(false);
  // Hidden past the grace period: the stream is closed until the tab is shown.
  // Separate from `live`, which is the user's choice and survives this.
  const suspended = useHiddenFor(HIDDEN_STREAM_GRACE_MS);
  const [timeRange, setTimeRange] = React.useState<TimeRange>(
    initialTimeRange ?? spec.timeRange,
  );
  const [connection, setConnection] =
    React.useState<ConnectionStatus>(INITIAL_CONNECTION);
  // A failure of the whole cycle rather than of one panel — an unresolvable
  // time range, typically. It belongs above the grid because it is not any one
  // panel's, and it clears on the next completed tick.
  const [dashboardError, setDashboardError] = React.useState<ApiError | null>(null);
  // Bumped by the manual Reconnect to tear the EventSource down and build a
  // new one; the browser's own retry schedule is not something a page can
  // shortcut, so the socket has to be replaced rather than nudged.
  const [reconnectNonce, setReconnectNonce] = React.useState(0);
  const lastTickRef = React.useRef<number>(0);
  // One renewal per closed stream (#27): a stream the server refused because
  // the session expired gets a fresh session and one more try; a second
  // refusal is something else, and is left to the Reconnect button.
  const renewTriedRef = React.useRef(false);
  // The last SSE event id this page saw, and the stream it came from (#43).
  // It is the server's record of what has been sent, so a new EventSource for
  // the same window — a manual Reconnect, a tab shown again, a reconnect after
  // renewal — resumes from it instead of starting over.
  const lastEventIdRef = React.useRef<{ url: string; id: string } | null>(null);
  const rolling = isRolling(timeRange);
  const streamUrl = React.useMemo(() => {
    const params = new URLSearchParams(timeRange);
    return `/api/dashboards/${dashboardId}/stream?${params.toString()}`;
  }, [dashboardId, timeRange]);

  /**
   * Keep the URL on the window being viewed, so a range is a link someone can
   * send.
   *
   * `history.replaceState` rather than `router.replace`: this is the same
   * route, and a Next navigation would re-render the server page and remount
   * this component — tearing down the EventSource and blanking every panel
   * every time the range changed.
   */
  React.useEffect(() => {
    const search = rangeSearch(timeRange, spec.timeRange);
    const url = `${window.location.pathname}${search}`;
    if (url !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, "", url);
    }
  }, [timeRange, spec.timeRange]);

  const signal = React.useCallback((s: ConnectionSignal) => {
    setConnection((prev) => reduceConnection(prev, s));
  }, []);

  const applyEvent = React.useCallback(
    (event: PollerEvent, at: number) => {
      setStates((prev) => {
        // Neither carries a panel id: a tick is freshness, a dashboard error is
        // handled by the caller and shown above the grid.
        if (event.type === "tick" || event.type === "dashboard-error") return prev;
        const cur = prev[event.panelId];
        if (event.type === "panel-error") {
          return {
            ...prev,
            [event.panelId]: {
              data: cur?.data ?? { columns: [], rows: [] },
              status: "error",
              error: { error: event.error, kind: event.kind },
              updatedAt: cur?.updatedAt,
            },
          };
        }
        if (event.type === "tombstone") {
          return {
            ...prev,
            [event.panelId]: {
              data: cur?.data ?? { columns: [], rows: [] },
              status: "tombstoned",
              updatedAt: cur?.updatedAt,
            },
          };
        }
        // event.type === "panel"
        const next = mergePanelRows(cur?.data, event, maxWindowPoints);
        return {
          ...prev,
          [event.panelId]: { data: next, status: "live", updatedAt: at },
        };
      });
    },
    [maxWindowPoints],
  );

  // `reconnectNonce` is listed as a dependency but never read in the body —
  // changing it is the whole point. Re-running this effect is the only way to
  // replace an EventSource, whose own retry schedule a page cannot reach.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the nonce exists to force a fresh EventSource
  React.useEffect(() => {
    if (!live || suspended) return;
    lastTickRef.current = Date.now();
    const last = lastEventIdRef.current;
    const resuming = last !== null && last.url === streamUrl;
    const es = new EventSource(
      resuming ? `${streamUrl}&lastEventId=${encodeURIComponent(last.id)}` : streamUrl,
    );
    // Only a stream that starts over clears the panels: a new window, or the
    // first load. A resumed one — this EventSource reconnecting by itself
    // with `Last-Event-ID`, or a new one carrying it — is sent only what the
    // panels are missing, so wiping them would throw away their history.
    let fresh = !resuming;
    es.onopen = () => {
      renewTriedRef.current = false;
      if (fresh) {
        fresh = false;
        setStates({});
      }
      setDashboardError(null);
      signal({ type: "open" });
    };
    es.onmessage = (msg) => {
      if (msg.lastEventId)
        lastEventIdRef.current = { url: streamUrl, id: msg.lastEventId };
      try {
        const event = JSON.parse(msg.data) as PollerEvent;
        if (event.type === "tick") {
          lastTickRef.current = event.at;
          // A tick only arrives on a completed cycle, so it is also the signal
          // that whatever broke the last one is over.
          setDashboardError(null);
          signal({ type: "tick", at: event.at });
        }
        if (event.type === "dashboard-error") {
          setDashboardError({ error: event.error, kind: event.kind });
          // The stream is healthy, the data behind it is not: every panel is
          // now only as fresh as its last frame, so say so rather than leave a
          // live badge over frozen charts.
          setStates(markStale);
        }
        applyEvent(event, Date.now());
      } catch {
        /* ignore malformed frame */
      }
    };
    es.onerror = () => {
      // Mark everything stale on transport error. `readyState === CLOSED` is
      // the browser saying it will NOT retry — an expired session on the
      // stream route, typically — which is the one case a manual Reconnect
      // cannot fix by itself but must still be distinguishable from a retry
      // already in flight.
      setStates(markStale);
      const closed = es.readyState === EventSource.CLOSED;
      signal({ type: "error", closed });
      // EventSource cannot see the status code, so a closed stream is treated
      // as a possible expiry: renew once and, if that worked, reconnect. If
      // the session is over, the keepalive banner asks for a sign-in.
      if (closed && !renewTriedRef.current) {
        renewTriedRef.current = true;
        void renewSession().then((result) => {
          if (result.ok) setReconnectNonce((n) => n + 1);
        });
      }
    };
    // The server sends this just before it stops, along with an SSE `retry:`
    // hint that EventSource honours: the reconnect lands on a healthy instance
    // after a spread-out delay, so say "stale" now rather than wait out the
    // watchdog.
    const onDraining = () => {
      setStates(markStale);
      signal({ type: "error", closed: false });
    };
    es.addEventListener(DRAIN_EVENT, onDraining);
    // The realm ended this session (#28). Close rather than let EventSource
    // retry into a 401; the renewal that follows is refused too, and that
    // refusal is what raises the keepalive's sign-in banner.
    const onSessionEnded = () => {
      es.close();
      setStates(markStale);
      signal({ type: "error", closed: true });
      renewTriedRef.current = true;
      void renewSession().then((result) => {
        if (result.ok) setReconnectNonce((n) => n + 1);
      });
    };
    es.addEventListener(SESSION_ENDED_EVENT, onSessionEnded);
    // The token this stream was opened with ran out (#32). Routine: the
    // keepalive has usually renewed the cookie already, so reconnect at once
    // and resume from the last event id. The panels stay live through it;
    // only a session that cannot be renewed marks them stale, and that
    // refusal raises the keepalive's sign-in banner rather than a retry loop.
    const onSessionExpired = () => {
      es.close();
      void ensureSession().then((result) => {
        if (result.ok) {
          setReconnectNonce((n) => n + 1);
          return;
        }
        setStates(markStale);
        signal({ type: "error", closed: true });
      });
    };
    es.addEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
    // This viewer may no longer see the dashboard, or it was deleted (#32).
    // Renewing would not change that, so stop and say why.
    const onAccessEnded = () => {
      es.close();
      setStates(markStale);
      setDashboardError({
        error: "This dashboard was deleted, or you no longer have access to it.",
        kind: "authorization",
      });
      signal({ type: "error", closed: true });
    };
    es.addEventListener(ACCESS_ENDED_EVENT, onAccessEnded);
    return () => {
      es.removeEventListener(DRAIN_EVENT, onDraining);
      es.removeEventListener(SESSION_ENDED_EVENT, onSessionEnded);
      es.removeEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
      es.removeEventListener(ACCESS_ENDED_EVENT, onAccessEnded);
      es.close();
    };
  }, [applyEvent, live, suspended, signal, streamUrl, reconnectNonce]);

  // Staleness watchdog. Disabled while paused — a paused dashboard is not stale.
  // An absolute window is frozen by definition: the poller keeps ticking, but
  // it re-queries the same seconds, so "no new data" is the correct state and
  // not a stale one.
  React.useEffect(() => {
    if (!live || !rolling) return;
    const budget = Math.max(spec.refreshIntervalMs * 2, 6_000);
    const id = setInterval(() => {
      if (Date.now() - lastTickRef.current > budget) {
        setStates(markStale);
      }
    }, budget);
    return () => clearInterval(id);
  }, [spec.refreshIntervalMs, live, rolling]);

  // Read `live` directly rather than from a `setLive` updater: the updater can
  // run twice under StrictMode, and signalling the reducer from inside it would
  // count the pause twice.
  function togglePause() {
    signal({ type: live ? "pause" : "resume" });
    setLive(!live);
    setIdlePaused(false);
  }

  useIdle(idlePauseMs, live && !suspended, () => {
    signal({ type: "pause" });
    setLive(false);
    setIdlePaused(true);
  });

  // Rendered in two places — the top bar from `lg`, the page body below it —
  // and only one is ever displayed, so the hidden copy is out of the
  // accessibility tree and its live region never announces.
  const streamControls = (
    <>
      <ConnectionIndicator
        status={connection}
        onReconnect={() => setReconnectNonce((n) => n + 1)}
      />
      <Button
        variant="ghost"
        size="icon"
        aria-pressed={!live}
        aria-label={live ? "Pause live updates" : "Resume live updates"}
        title={live ? "Pause live updates" : "Resume live updates"}
        className={cn(
          "h-8 w-8",
          // Paused is a state worth noticing — the numbers on screen have
          // stopped moving — so it takes the warning tone the time picker
          // uses for a fixed window.
          live ? "text-muted hover:text-foreground" : "text-warning hover:text-warning",
        )}
        onClick={togglePause}
      >
        {live ? (
          <Pause className="pop-in h-4 w-4" />
        ) : (
          <Play className="pop-in h-4 w-4 fill-current" />
        )}
      </Button>
      <TimeRangeFilter value={timeRange} onChange={setTimeRange} />
    </>
  );

  return (
    <div>
      <div className="mb-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">{header}</div>
          {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
        </div>
        {/*
          Below `lg` the top bar has no room for the stream controls, so they
          sit here under the title instead; from `lg` they are portalled into
          the bar (see `NavSlot`).
        */}
        <div className="flex flex-wrap items-center gap-2 lg:hidden">
          {streamControls}
        </div>
      </div>
      <NavPortal>{streamControls}</NavPortal>

      <Notice open={idlePaused && !live} role="status">
        <div className="mb-4 flex flex-wrap items-center gap-3 border border-border bg-surface px-3 py-2 text-sm">
          <p className="flex-1 text-muted">
            Live updates paused after{" "}
            {idlePauseMs !== undefined ? Math.round(idlePauseMs / 60_000) : 0} minutes
            without activity.
          </p>
          <Button variant="secondary" size="sm" onClick={togglePause}>
            <Play className="h-3.5 w-3.5 fill-current" aria-hidden />
            Resume
          </Button>
        </div>
      </Notice>

      {dashboardError && <ErrorDisplay error={dashboardError} className="mb-4" />}

      <DashboardGrid
        panels={spec.panels}
        empty={empty}
        renderPanel={(panel) => (
          <PanelView
            panel={panel}
            state={states[panel.id]}
            paused={!live}
            timeRange={timeRange}
            dashboardTitle={spec.title}
            crosshairGroup={dashboardId}
            onSelectTimeRange={setTimeRange}
          />
        )}
      />
    </div>
  );
}
