"use client";

import * as React from "react";
import { useReducedMotion } from "@/components/motion-preference";
import { useFlip } from "@/components/use-flip";

/**
 * A container whose `[data-flip-id]` descendants slide when they move (#237),
 * for a list that is rendered on the server. `useFlip` matches by id, not by
 * element, so a card whose DOM the server re-creates on `router.refresh()`
 * still slides from where its predecessor was.
 */
export function FlipGroup({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  useFlip(ref, !useReducedMotion());
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
