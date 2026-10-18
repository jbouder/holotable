import { Database, Lock } from "lucide-react";

/**
 * The menu triggers that sit in a prompt bar beside the input (#362): the
 * source chip, and on Chat the sources a conversation uses. One height and
 * one border, so the bar reads as a single row.
 */
export const COMPOSER_CHIP_CLASS =
  "h-10 w-auto max-w-full gap-1.5 border border-border bg-surface px-3 text-sm text-foreground";

/**
 * The source chip's accessible name: its visible text, in order, with the
 * prefix before it and "(workspace)" beside it. A name that holds the words a
 * sighted person sees is WCAG 2.5.3 (Label in Name), which axe checks word by
 * word in order, leaving out parentheses.
 */
export function sourceChipName(
  prefix: string,
  { name, workspaceId, extra = 0 }: { name: string; workspaceId: string; extra?: number },
): string {
  return `${prefix}: ${name}, ${workspaceId} (workspace)${extra > 0 ? `, +${extra} more` : ""}`;
}

/**
 * What the source chip shows: the source, its workspace, and how many more.
 * The space between the parts is not drawn (they are flex items) but keeps
 * the words apart in the text a checker reads off the trigger.
 */
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
      <span className="truncate">{name}</span>{" "}
      <span className="shrink-0 text-xs text-muted">
        {workspaceId}
        {extra > 0 && ` +${extra}`}
      </span>
    </>
  );
}
