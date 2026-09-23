import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The title block at the top of a page: the heading, a sentence on what the
 * page is for, and the page's own actions on the right.
 *
 * A page renders it in every state — empty, loading and populated alike — so
 * an empty workspace still says where you are before the empty state says what
 * to do next. The pages used to write their own `h1`, and drifted: one had a
 * description, one did not, and two dropped the header entirely when empty.
 */
export function PageHeader({
  title,
  badge,
  description,
  actions,
  className,
}: {
  title: string;
  /** Sits beside the title, e.g. the generation model. */
  badge?: React.ReactNode;
  description: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{title}</h1>
          {badge}
        </div>
        <p className="mt-1 text-sm text-muted">{description}</p>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
