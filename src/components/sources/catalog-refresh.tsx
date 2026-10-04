"use client";

import * as React from "react";
import { AlertTriangle, Check, Loader2, Minus, Plus, RefreshCw } from "lucide-react";
import type { CatalogHealth } from "@/lib/catalog/health";
import {
  applyCatalogRefresh,
  type CatalogDiff,
  droppedHiddenColumns,
  isUnchanged,
  previewCatalogRefresh,
  type RefreshPreview,
  summarizeCatalogDiff,
} from "@/lib/catalog/refresh";
import type { ApiError } from "@/lib/errors";
import { isExposed } from "@/lib/registry";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorDisplay } from "@/components/ui/error-display";

/**
 * A catalog refresh, reviewed before it is written (#123).
 *
 * Opening it runs the preview: the server introspects and answers with what
 * would change. Nothing is stored until **Apply**, which sends the preview's
 * digest back. If the database moved in between, the server refuses, and the
 * new diff replaces the old one with a line saying why, so the author always
 * applies what is on screen.
 *
 * Every refresh in the app goes through this: the source list, the catalog
 * browser, the pickers' notice and the command palette.
 */

export interface RefreshApplied {
  diff: CatalogDiff;
  catalogHealth: CatalogHealth;
}

type State =
  | { step: "loading" }
  | { step: "failed"; error: ApiError }
  | {
      step: "review";
      preview: RefreshPreview;
      applying: boolean;
      /** Set when an apply was refused because the database had changed. */
      moved?: string;
      error?: ApiError;
    };

export function CatalogRefreshReview({
  sourceId,
  onApplied,
  onCancel,
}: {
  sourceId: string;
  onApplied: (result: RefreshApplied) => void;
  onCancel: () => void;
}) {
  const [state, setState] = React.useState<State>({ step: "loading" });

  const load = React.useCallback(async () => {
    setState({ step: "loading" });
    const result = await previewCatalogRefresh(sourceId);
    setState(
      result.ok
        ? { step: "review", preview: result.preview, applying: false }
        : { step: "failed", error: result.error },
    );
  }, [sourceId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function apply(preview: RefreshPreview) {
    setState({ step: "review", preview, applying: true });
    const result = await applyCatalogRefresh(sourceId, preview.digest);
    if (result.ok) {
      onApplied({ diff: result.diff, catalogHealth: result.catalogHealth });
      return;
    }
    setState(
      result.changed
        ? {
            step: "review",
            preview: result.changed,
            applying: false,
            moved: result.error.error,
          }
        : { step: "review", preview, applying: false, error: result.error },
    );
  }

  if (state.step === "loading") {
    return (
      <p className="flex items-center gap-2 text-sm text-muted" role="status">
        <Loader2 className="h-4 w-4 animate-spin" /> Reading the catalog from the
        database…
      </p>
    );
  }

  if (state.step === "failed") {
    return (
      <div className="space-y-4">
        <ErrorDisplay
          error={state.error}
          onRetry={() => void load()}
          retryLabel="Try again"
        />
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onCancel}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  const { preview, applying } = state;
  const unchanged = isUnchanged(preview.diff);

  return (
    <div className="space-y-4">
      {state.moved && (
        <p
          role="alert"
          className="drop-in border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning"
        >
          {state.moved}
        </p>
      )}
      <CatalogDiffView diff={preview.diff} />
      {state.error && <ErrorDisplay error={state.error} />}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={applying}>
          Cancel
        </Button>
        <Button onClick={() => void apply(preview)} disabled={applying}>
          {applying ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          {unchanged ? "Mark as refreshed" : "Apply changes"}
        </Button>
      </div>
    </div>
  );
}

/** The change set itself. Exported for the tests. */
export function CatalogDiffView({ diff }: { diff: CatalogDiff }) {
  const dropped = droppedHiddenColumns(diff);
  const added = diff.tables.some((t) => t.added.length > 0);

  return (
    <div className="space-y-3 text-sm">
      <p className="text-foreground">{summarizeCatalogDiff(diff)}</p>

      {diff.missingTables.length > 0 && (
        <div
          role="alert"
          className="space-y-1 border border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger"
        >
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            Not found in the database: {diff.missingTables.join(", ")}
          </p>
          <p className="text-muted">
            Dropped, renamed, or no longer readable by the source&rsquo;s role. They stay
            in the allowlist with their last known columns, but are left out of the
            model&rsquo;s catalog until a refresh finds them again. Edit the source to
            remove them if they are gone for good.
          </p>
        </div>
      )}

      {diff.restoredTables.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-success">
          <Check className="h-3.5 w-3.5 shrink-0" />
          Found again: {diff.restoredTables.join(", ")}
        </p>
      )}

      {diff.tables.length > 0 && (
        <ul className="divide-y divide-border border border-border">
          {diff.tables.map((change) => (
            <li key={change.table} className="space-y-1 px-3 py-2">
              <p className="font-mono text-xs font-medium text-foreground">
                {change.table}
              </p>
              <ul className="space-y-0.5 font-mono text-xs">
                {change.added.map((column) => (
                  <li
                    key={`+${column.name}`}
                    className="flex items-center gap-1.5 text-success"
                  >
                    <Plus className="h-3 w-3 shrink-0" aria-label="added" />
                    {column.name}
                    <span className="text-muted">{column.type}</span>
                  </li>
                ))}
                {change.removed.map((column) => (
                  <li
                    key={`-${column.name}`}
                    className="flex items-center gap-1.5 text-danger"
                  >
                    <Minus className="h-3 w-3 shrink-0" aria-label="removed" />
                    {column.name}
                    <span className="text-muted">{column.type}</span>
                    {!isExposed(column) && <Badge>hidden</Badge>}
                  </li>
                ))}
                {change.retyped.map((column) => (
                  <li
                    key={`~${column.name}`}
                    className="flex flex-wrap items-center gap-1.5 text-warning"
                  >
                    <RefreshCw className="h-3 w-3 shrink-0" aria-label="type changed" />
                    {column.name}
                    <span className="text-muted">
                      {column.from} → {column.to}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {added && (
        <p className="text-xs text-muted">
          New columns start exposed: the model is told about them and generated SQL may
          read them. Hide any that should not be queried after applying.
        </p>
      )}
      {dropped.length > 0 && (
        <p className="text-xs text-warning">
          {dropped.join(", ")} {dropped.length === 1 ? "was" : "were"} hidden. If{" "}
          {dropped.length === 1 ? "it comes" : "they come"} back,{" "}
          {dropped.length === 1 ? "it" : "they"} will start exposed.
        </p>
      )}
    </div>
  );
}

/** The review in its own dialog, for the surfaces that have nowhere else to put it. */
export function RefreshCatalogDialog({
  source,
  onClose,
  onApplied,
}: {
  /** The source being refreshed; null keeps the dialog closed. */
  source: { id: string; name: string } | null;
  onClose: () => void;
  onApplied: (result: RefreshApplied) => void;
}) {
  return (
    <Dialog
      open={source !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={source ? `Refresh catalog: ${source.name}` : "Refresh catalog"}
    >
      {source && (
        <CatalogRefreshReview
          key={source.id}
          sourceId={source.id}
          onApplied={onApplied}
          onCancel={onClose}
        />
      )}
    </Dialog>
  );
}
