"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorDisplay } from "@/components/ui/error-display";
import type { ApiError } from "@/lib/errors";
import {
  type SourceImpact,
  deleteTombstones,
  describeDeleteConsequence,
  describeImpact,
  fetchSourceImpact,
  impactCounts,
} from "@/lib/source-impact";

/**
 * What depends on a source, in the source list: the hook that asks, the cell
 * that reports, and the delete confirmation that puts the consequence in front
 * of the person about to cause it.
 *
 * The contract and the wording live in `@/lib/source-impact`; this file is the
 * wiring.
 */

export type SourceImpactState =
  | { status: "loading" }
  | { status: "ready"; impact: SourceImpact }
  | { status: "error"; error: ApiError };

/**
 * Impact for every source in the list, keyed by source id.
 *
 * One request per source rather than one per press: the count belongs in the
 * row, and a delete confirmation that had to wait for a fetch would show its
 * button before it showed the consequence. The whole batch is abandoned when
 * the list changes under it.
 */
export function useSourceImpactMap(
  sourceIds: string[],
): Record<string, SourceImpactState> {
  // The distinct ids as one primitive, so the effect re-runs on a changed set
  // rather than on every new array identity.
  const key = [...new Set(sourceIds)].sort().join("\u0000");
  const [map, setMap] = React.useState<Record<string, SourceImpactState>>({});

  React.useEffect(() => {
    if (key === "") return;
    const ids = key.split("\u0000");
    setMap(Object.fromEntries(ids.map((id) => [id, { status: "loading" as const }])));

    const controller = new AbortController();
    void Promise.all(
      ids.map(async (id) => {
        const outcome = await fetchSourceImpact(id, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setMap((current) => ({
          ...current,
          [id]: outcome.ok
            ? { status: "ready", impact: outcome.impact }
            : { status: "error", error: outcome.error },
        }));
      }),
    );

    return () => controller.abort();
  }, [key]);

  return map;
}

/** The "Used by" cell: counts, and a way to see which. */
export function ImpactCell({
  state,
  onOpen,
}: {
  state: SourceImpactState | undefined;
  onOpen: () => void;
}) {
  if (!state || state.status === "loading") {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />;
  }
  if (state.status === "error") {
    return <span className="text-xs text-muted">—</span>;
  }
  const { dashboards, panels } = impactCounts(state.impact);
  if (panels === 0) return <span className="text-xs text-muted">Unused</span>;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="cursor-pointer text-xs text-foreground underline-offset-4 hover:underline"
    >
      {panels} {panels === 1 ? "panel" : "panels"} · {dashboards}{" "}
      {dashboards === 1 ? "dashboard" : "dashboards"}
    </button>
  );
}

/** Every dashboard and panel that references the source. */
export function ImpactList({ impact }: { impact: SourceImpact }) {
  if (impact.dashboards.length === 0) {
    return (
      <p className="text-sm text-muted">No dashboard currently references this source.</p>
    );
  }
  return (
    <ul className="space-y-3">
      {impact.dashboards.map((dashboard) => (
        <li key={dashboard.id} className="border border-border bg-surface-2 p-3">
          <Link
            href={`/dashboards/${dashboard.id}`}
            className="text-sm font-medium underline-offset-4 hover:underline"
          >
            {dashboard.title}
          </Link>
          <ul className="mt-1 space-y-0.5">
            {dashboard.panels.map((panel) => (
              <li key={panel.id} className="text-xs text-muted">
                {panel.title} <span className="text-muted/70">({panel.id})</span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/** The read-only view behind the "Used by" cell. */
export function SourceImpactDialog({
  name,
  state,
  onClose,
}: {
  name: string;
  state: SourceImpactState | undefined;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={`Used by — ${name}`}>
      <ImpactBody state={state} />
    </Dialog>
  );
}

/**
 * Delete, with the consequence stated first.
 *
 * The button stays available while impact is still loading or failed to load:
 * the check is `deleteSource()`'s to make and it makes it on the server either
 * way, so a failed lookup must not become a lock on deleting a source.
 */
export function DeleteSourceDialog({
  name,
  state,
  busy,
  onConfirm,
  onCancel,
}: {
  name: string;
  state: SourceImpactState | undefined;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const tombstones = state?.status === "ready" && deleteTombstones(state.impact);
  const breaks = state?.status === "ready" && impactCounts(state.impact).panels > 0;
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()} title={`Delete ${name}?`}>
      <div className="space-y-4">
        {state?.status === "ready" ? (
          <p className="flex items-start gap-2 text-sm">
            {tombstones && (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            )}
            <span>{describeDeleteConsequence(state.impact)}</span>
          </p>
        ) : (
          <p className="text-sm text-muted">
            {state?.status === "error"
              ? "Could not check what depends on this source. A referenced source is tombstoned rather than removed either way."
              : "Checking what depends on this source…"}
          </p>
        )}
        {state?.status === "ready" && breaks && <ImpactList impact={state.impact} />}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {tombstones ? "Delete and tombstone" : "Delete source"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function ImpactBody({ state }: { state: SourceImpactState | undefined }) {
  if (!state || state.status === "loading") {
    return <p className="text-sm text-muted">Loading…</p>;
  }
  if (state.status === "error") {
    return <ErrorDisplay layout="block" error={state.error} />;
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">Used by {describeImpact(state.impact)}.</p>
      <ImpactList impact={state.impact} />
    </div>
  );
}
