"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * An inline notice or banner that enters and leaves in place (#235).
 *
 * The `notice` utility in `globals.css` does the motion; what this adds is
 * staying mounted. A `{notice && <div>}` has nothing left to fade once the
 * condition is false, so the element is always rendered, `data-open` toggles,
 * and the last content shown is kept on screen until the exit has played.
 * Under Reduce the transition is 0.01ms and the swap is immediate.
 */
export function Notice({
  open,
  children,
  className,
  role,
}: {
  open: boolean;
  children: React.ReactNode;
  className?: string;
  role?: React.AriaRole;
}) {
  // What to show while closing. Read and written during render on purpose:
  // state would lag the open render by a frame and the box would open empty.
  const last = React.useRef<React.ReactNode>(null);
  if (open) last.current = children;

  return (
    <div className={cn("notice", className)} data-open={open || undefined} role={role}>
      {open ? children : last.current}
    </div>
  );
}
