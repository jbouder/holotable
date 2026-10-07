import type * as React from "react";
import { ChevronRight } from "lucide-react";

/**
 * One titled, collapsible group in the editor's inspector (#357).
 *
 * A native `<details>`: the browser owns the open state, the keyboard and the
 * announcement, and nothing animates its height (motion rules: no height
 * transitions outside Base UI's Collapsible). Sections the author reaches for
 * most often start open; the rest stay one click away.
 */
export function InspectorSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={defaultOpen} className="group border-t border-border">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-3 text-sm font-medium text-foreground select-none focus-visible:outline-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="h-4 w-4 text-muted transition-transform duration-(--duration-fast) ease-standard group-open:rotate-90"
        />
        {title}
      </summary>
      <div className="space-y-3 pb-4">{children}</div>
    </details>
  );
}
