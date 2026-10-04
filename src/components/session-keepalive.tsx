"use client";

import * as React from "react";
import { LogIn } from "lucide-react";
import { Notice } from "@/components/notice";
import {
  type RenewResult,
  readSharedExpiry,
  renewalDelay,
  renewSession,
  SESSION_EVENT,
  SESSION_EXPIRY_KEY,
} from "@/lib/session-renewal";

/** After a failed renewal that was not a refusal, try again this soon. */
const RETRY_MS = 15_000;

/**
 * Keeps a signed-in session alive (#27), and says so when it cannot.
 *
 * Renews shortly before the session token expires, and again whenever the tab
 * comes back into view past that point (a timer does not run while a laptop
 * sleeps). When the server answers that the session is over, a banner asks
 * the person to sign in again instead of leaving a dashboard that has quietly
 * stopped updating. Mounted by the root layout for a signed-in OIDC session
 * only; demo sessions have no realm to renew against.
 */
export function SessionKeepalive({ expiresAt: initial }: { expiresAt: number }) {
  const [ended, setEnded] = React.useState(false);
  const expiresAt = React.useRef(initial);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dueAt = React.useRef(0);

  React.useEffect(() => {
    let stopped = false;

    const schedule = (delay: number) => {
      clearTimeout(timer.current);
      dueAt.current = Date.now() + delay;
      timer.current = setTimeout(() => void renew(), delay);
    };

    const adopt = (next: number) => {
      expiresAt.current = Math.max(expiresAt.current, next);
      schedule(renewalDelay(expiresAt.current, Date.now()));
    };

    const renew = async () => {
      // Another tab may already have renewed for everyone.
      const shared = readSharedExpiry();
      if (
        shared !== null &&
        renewalDelay(shared, Date.now()) > 0 &&
        shared > expiresAt.current
      ) {
        adopt(shared);
        return;
      }
      // The outcome arrives through SESSION_EVENT, like any other renewal.
      await renewSession();
    };

    const onResult = (event: Event) => {
      if (stopped) return;
      const result = (event as CustomEvent<RenewResult>).detail;
      if (result.ok) {
        setEnded(false);
        adopt(result.expiresAt);
      } else if (result.ended) {
        clearTimeout(timer.current);
        setEnded(true);
      } else {
        schedule(RETRY_MS);
      }
    };

    const onStorage = (event: StorageEvent) => {
      if (event.key !== SESSION_EXPIRY_KEY || event.newValue === null) return;
      const next = Number(event.newValue);
      if (Number.isFinite(next)) {
        setEnded(false);
        adopt(next);
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() >= dueAt.current) {
        void renew();
      }
    };

    window.addEventListener(SESSION_EVENT, onResult);
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisible);
    schedule(renewalDelay(expiresAt.current, Date.now()));
    return () => {
      stopped = true;
      clearTimeout(timer.current);
      window.removeEventListener(SESSION_EVENT, onResult);
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return (
    <Notice open={ended} role="alert">
      <div className="flex flex-wrap items-center gap-3 border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm sm:px-6">
        <p className="flex-1">
          <span className="font-medium">Your session has ended.</span>{" "}
          <span className="text-muted">
            Live updates and saving have stopped. Sign in again to carry on.
          </span>
        </p>
        <a
          href="/api/auth/login"
          className="inline-flex items-center gap-1.5 font-medium text-primary underline-offset-2 hover:underline"
        >
          <LogIn className="h-4 w-4" aria-hidden /> Sign in again
        </a>
      </div>
    </Notice>
  );
}
