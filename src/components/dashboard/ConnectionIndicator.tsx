"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";
import {
  connectionAnnouncement,
  connectionLabel,
  connectionTone,
  type ConnectionStatus,
  type ConnectionTone,
  formatAge,
  shouldOfferReconnect,
} from "@/lib/connection";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const DOT: Record<ConnectionTone, string> = {
  live: "animate-pulse bg-success",
  warning: "animate-pulse bg-warning",
  danger: "bg-danger",
  muted: "bg-muted",
};

const TEXT: Record<ConnectionTone, string> = {
  live: "text-muted",
  warning: "text-warning",
  danger: "text-danger",
  muted: "text-muted",
};

/**
 * The dashboard's connection and freshness readout.
 *
 * It owns its own one-second timer so that "updated 12s ago" can tick without
 * re-rendering every panel and every chart once a second — the reason the age
 * lives here rather than in `LiveDashboard`'s state.
 *
 * The whole thing is one `aria-live="polite"` region carrying a sentence
 * (`connectionAnnouncement`) rather than the visual fragments, so a state
 * change is announced as "Reconnecting, attempt 3. updated 42s ago." instead of
 * a stream of stray numbers as the seconds count up. `aria-atomic` keeps the
 * sentence whole.
 */
export function ConnectionIndicator({
  status,
  onReconnect,
}: {
  status: ConnectionStatus;
  onReconnect: () => void;
}) {
  const now = useTickingNow(status.lastEventAt !== undefined);
  const tone = connectionTone(status.state);
  const offerReconnect = shouldOfferReconnect(status);

  return (
    <div className="flex items-center gap-2">
      <div
        // The text below is duplicated visually; the live region is what a
        // screen reader reads, so it carries the full sentence and the visual
        // spans are hidden from the accessibility tree.
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={cn("flex items-center gap-1.5 text-xs", TEXT[tone])}
      >
        <span className="sr-only">{connectionAnnouncement(status, now)}</span>
        <span
          aria-hidden="true"
          className={cn("h-2 w-2 shrink-0 rounded-full", DOT[tone])}
        />
        <span aria-hidden="true" className="font-medium">
          {connectionLabel(status)}
        </span>
        <span aria-hidden="true" className="text-muted">
          · {formatAge(status.lastEventAt, now)}
        </span>
      </div>
      {offerReconnect && (
        <Button variant="secondary" size="sm" onClick={onReconnect}>
          <RefreshCw className="h-3.5 w-3.5" /> Reconnect
        </Button>
      )}
    </div>
  );
}

/**
 * `Date.now()`, re-read once a second while there is an age to count up.
 *
 * The interval is not started before the first tick arrives: until then the age
 * reads "no data yet", which does not change, and a timer that re-renders for
 * no reason is the thing this hook exists to avoid.
 */
function useTickingNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}
