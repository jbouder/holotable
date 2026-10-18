"use client";

import * as React from "react";
import { FlaskConical, Laptop, type LucideIcon, X } from "lucide-react";
import { Notice } from "@/components/notice";
import { browserStorage } from "@/lib/browser-storage";
import {
  type BannerMode,
  demoBannerDismissed,
  dismissDemoBanner,
} from "@/lib/demo-banner";

/** What the banner says in each mode that signs people in without a login. */
const COPY: Record<
  BannerMode,
  { icon: LucideIcon; lead: string; body: string; dismiss: string }
> = {
  demo: {
    icon: FlaskConical,
    lead: "This is a demo.",
    body: "Everyone shares the same workspace, so others can see and change what you build, and the data may be reset at any time.",
    dismiss: "Dismiss the demo notice",
  },
  local: {
    icon: Laptop,
    lead: "Local mode.",
    body: "Everyone who can reach this server is signed in as its owner and can manage its sources, so keep it on your own machine.",
    dismiss: "Dismiss the local mode notice",
  },
};

/**
 * The persistent banner for the modes without a login: in demo mode (#251),
 * that everyone shares one workspace and the data may be reset; in local mode
 * (#600), that everyone who can reach the server is its owner. Rendered by the
 * root layout only when `AUTH_MODE` is `demo` or `local`, which hands it the
 * mode (the browser bundle has no `AUTH_MODE`). Starts closed and opens after
 * mount, because whether this viewer dismissed it lives in `localStorage`,
 * which the server cannot read; opening late is the `Notice` entrance rather
 * than a flash.
 */
export function DemoBanner({ mode }: { mode: BannerMode }) {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    setOpen(!demoBannerDismissed(browserStorage(), mode));
  }, [mode]);

  const copy = COPY[mode];
  const Icon = copy.icon;
  return (
    <Notice open={open} role="status">
      <div className="flex items-start gap-3 border-b border-primary/30 bg-primary/10 px-4 py-2 text-sm sm:px-6">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <p className="flex-1">
          <span className="font-medium">{copy.lead}</span>{" "}
          <span className="text-muted">{copy.body}</span>
        </p>
        <button
          type="button"
          onClick={() => {
            dismissDemoBanner(browserStorage(), mode);
            setOpen(false);
          }}
          className="tap-target -my-1 inline-flex shrink-0 items-center justify-center text-muted transition-colors duration-(--duration-fast) ease-standard hover:text-foreground"
          aria-label={copy.dismiss}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </Notice>
  );
}
