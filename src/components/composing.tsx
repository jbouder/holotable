import type * as React from "react";
import { Compass } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * While the model writes a spec: one line, the compass pulsing, and the title
 * as soon as the stream has one. The same on every generation surface, so
 * waiting for a dashboard and waiting for an Explore answer look alike.
 */
export function ComposingStatus({
  what,
  title,
  detail,
}: {
  /** What is being written, before a title arrives: "a query", "a dashboard". */
  what: string;
  /** The title streamed so far, if any. */
  title?: string;
  /** A short note after the title, e.g. how many panels have arrived. */
  detail?: string;
}) {
  return (
    <WorkingStatus>
      {title ? `Composing “${title}”…` : `Composing ${what}…`}
      {detail && ` · ${detail}`}
    </WorkingStatus>
  );
}

/**
 * The pulsing compass and a short line of what the model is doing. The one
 * waiting state every model surface shows: Explore, a new dashboard, and the
 * dashboard chat's "Thinking…" and "Querying data…" (#366).
 */
export function WorkingStatus({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      role="status"
      className={cn("flex items-center gap-2 text-sm text-muted", className)}
    >
      <Compass className="h-4 w-4 shrink-0 animate-pulse" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/**
 * Where the answer will appear, before there is one. It grows to fill the
 * rest of the page (the page root is a flex column; see `src/app/template.tsx`),
 * and holds the composing status while the first answer is written.
 */
export function CanvasPlaceholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-80 flex-1 items-center justify-center border border-dashed border-border p-8 text-center text-sm text-muted">
      {children}
    </div>
  );
}
