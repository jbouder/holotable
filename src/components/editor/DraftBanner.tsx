"use client";

import { History, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { type DraftOffer, summarizeDraftChanges } from "@/lib/editor/drafts";
import { relativeTime } from "@/lib/editor/session";

/**
 * The offer to restore autosaved work (#118).
 *
 * Nothing here applies itself. The conflict case in particular says out loud
 * that the dashboard moved on while the draft sat in this browser, because the
 * alternative — restoring on top of it without a word — is how one author's
 * save quietly undoes another's.
 */
export function DraftBanner({
  offer,
  now,
  onRestore,
  onDiscard,
}: {
  offer: Extract<DraftOffer, { kind: "restorable" | "conflict" }>;
  /** Epoch ms used to render "3 minutes ago"; read once on mount by the editor. */
  now: number;
  onRestore: () => void;
  onDiscard: () => void;
}) {
  const conflict = offer.kind === "conflict";
  const summary = summarizeDraftChanges(offer.changes);
  const when = relativeTime(offer.draft.savedAt, now);

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 border px-3 py-2 text-sm ${
        conflict ? "border-warning/40 bg-warning/10" : "border-border bg-surface-2"
      }`}
    >
      <p className="flex items-start gap-2">
        {conflict ? (
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        ) : (
          <History className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
        )}
        <span>
          {conflict ? (
            <>
              You have unsaved changes from {when}, made against version{" "}
              {offer.draft.baseVersion}. This dashboard has been saved since then, and you
              are looking at the newer version. Restoring keeps your changes and saves
              them as a new version on top &mdash; it does not delete anyone else&rsquo;s.
            </>
          ) : (
            <>Unsaved changes from {when} are still here.</>
          )}
          {summary && <span className="block text-xs text-muted">{summary}</span>}
        </span>
      </p>
      <div className="flex shrink-0 gap-2">
        <Button variant="ghost" size="sm" onClick={onDiscard}>
          Discard
        </Button>
        <Button variant="secondary" size="sm" onClick={onRestore}>
          Restore
        </Button>
      </div>
    </div>
  );
}
