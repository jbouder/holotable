import type * as React from "react";
import { Card, CardContent } from "@/components/ui/card";

/**
 * An empty surface that says what to do next.
 *
 * Every empty state in the app goes through this, so "nothing here" is always
 * followed by the reason and the action rather than being left as a bare
 * sentence in muted text.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  /** A lucide icon element, sized by the caller. */
  icon?: React.ReactNode;
  title: string;
  description: React.ReactNode;
  /** A button or link. Omitted when the reader cannot act. */
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardContent className="flex flex-col items-center gap-2 px-6 py-10 text-center">
        {icon && <div className="mb-1 text-muted">{icon}</div>}
        <p className="text-sm font-semibold">{title}</p>
        <div className="max-w-prose text-sm text-muted">{description}</div>
        {action && <div className="mt-3">{action}</div>}
      </CardContent>
    </Card>
  );
}
