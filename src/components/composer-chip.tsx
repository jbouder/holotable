import { Database, Lock } from "lucide-react";

/**
 * The menu triggers that sit in a prompt bar beside the input (#362): the
 * source chip, and on Explore the time range and auto-refresh. One height and
 * one border, so the bar reads as a single row.
 */
export const COMPOSER_CHIP_CLASS =
  "h-10 w-auto max-w-full gap-1.5 border border-border bg-surface px-3 text-sm text-foreground";

/** What the source chip shows: the source, its workspace, and how many more. */
export function SourceChipLabel({
  name,
  workspaceId,
  extra = 0,
  locked = false,
}: {
  name: string;
  workspaceId: string;
  extra?: number;
  /** A conversation is open and the source is fixed for it. */
  locked?: boolean;
}) {
  return (
    <>
      {locked ? (
        <Lock className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
      ) : (
        <Database className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
      )}
      <span className="truncate">{name}</span>
      <span className="shrink-0 text-xs text-muted">
        {workspaceId}
        {extra > 0 && ` +${extra}`}
      </span>
    </>
  );
}
