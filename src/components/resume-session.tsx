"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RESUME_ATTEMPT_KEY, renewSession } from "@/lib/session-renewal";

/** One silent attempt per tab in this window, so a refusal cannot loop. */
const ATTEMPT_WINDOW_MS = 30_000;

/**
 * The sign-in card's quiet first move (#27). A tab that slept past its
 * session token lands here although the realm session behind it may still be
 * good; the renewal cookie outlives the token for exactly this case. So
 * before asking anyone to sign in, try to renew, and if that works re-render
 * the page they were on. Renders a line only while it is trying.
 */
export function ResumeSession() {
  const router = useRouter();
  const [trying, setTrying] = React.useState(false);

  React.useEffect(() => {
    let last = 0;
    try {
      last = Number(window.sessionStorage.getItem(RESUME_ATTEMPT_KEY)) || 0;
      window.sessionStorage.setItem(RESUME_ATTEMPT_KEY, String(Date.now()));
    } catch {
      /* no storage: the component state below still allows one attempt */
    }
    if (Date.now() - last < ATTEMPT_WINDOW_MS) return;
    let cancelled = false;
    setTrying(true);
    void renewSession().then((result) => {
      if (cancelled) return;
      setTrying(false);
      if (result.ok) router.refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!trying) return null;
  return (
    <p role="status" className="text-center text-xs text-muted">
      Resuming your session…
    </p>
  );
}
