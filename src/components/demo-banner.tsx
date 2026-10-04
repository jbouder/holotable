"use client";

import * as React from "react";
import { FlaskConical, X } from "lucide-react";
import { Notice } from "@/components/notice";
import { browserStorage } from "@/lib/browser-storage";
import { demoBannerDismissed, dismissDemoBanner } from "@/lib/demo-banner";

/**
 * The persistent demo-mode banner (#251): everyone shares one workspace, and
 * the data may be reset. Rendered by the root layout only when
 * `AUTH_MODE=demo`. Starts closed and opens after mount, because whether this
 * viewer dismissed it lives in `localStorage`, which the server cannot read;
 * opening late is the `Notice` entrance rather than a flash.
 */
export function DemoBanner() {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    setOpen(!demoBannerDismissed(browserStorage()));
  }, []);

  return (
    <Notice open={open} role="status">
      <div className="flex items-start gap-3 border-b border-primary/30 bg-primary/10 px-4 py-2 text-sm sm:px-6">
        <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <p className="flex-1">
          <span className="font-medium">This is a demo.</span>{" "}
          <span className="text-muted">
            Everyone shares the same workspace, so others can see and change what you
            build, and the data may be reset at any time.
          </span>
        </p>
        <button
          type="button"
          onClick={() => {
            dismissDemoBanner(browserStorage());
            setOpen(false);
          }}
          className="tap-target -my-1 inline-flex shrink-0 items-center justify-center text-muted transition-colors duration-(--duration-fast) ease-standard hover:text-foreground"
          aria-label="Dismiss the demo notice"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </Notice>
  );
}
