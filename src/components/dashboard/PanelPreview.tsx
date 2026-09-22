"use client";

import * as React from "react";
import { CheckCircle2, Loader2, Play, ShieldCheck } from "lucide-react";
import type { Panel, TimeRange } from "@/lib/ir";
import {
  type PanelQueryOutcome,
  type SqlCheck,
  EMPTY_ROWS,
  runPanelQuery,
  checkSubject,
  runSubject,
  summarizeResult,
  validatePanelSql,
} from "@/lib/panel-query";
import { Button } from "@/components/ui/button";
import { ErrorDisplay } from "@/components/ui/error-display";
import { PanelView, type PanelState } from "@/components/dashboard/PanelView";

/**
 * Check a panel's SQL, and run it, without saving anything.
 *
 * Both actions go through the routes the dashboard itself uses — `/api/query`
 * for the run, `/api/sql/validate` for the check — so what the author sees here
 * is what the panel will do, and neither touches the dashboard or writes a
 * version. The result renders through {@link PanelView} with the panel's own
 * viz and format for the same reason: a preview that renders differently from
 * the panel is not a preview.
 *
 * Each verdict remembers what it answered (`checkSubject` / `runSubject`).
 * Editing past it retracts a stale "valid" — which would otherwise be a lie —
 * and marks a stale result `stale`, the state `PanelView` already dims.
 */

type Busy = "validate" | "run" | null;

export interface PanelPreviewController {
  busy: Busy;
  /** The last check, or `null` when there is none for the current statement. */
  check: SqlCheck | null;
  result: { outcome: PanelQueryOutcome; stale: boolean; at: number } | null;
  validate: () => void;
  run: () => void;
}

export function usePanelPreview(panel: Panel, timeRange: TimeRange) {
  const [busy, setBusy] = React.useState<Busy>(null);
  const [check, setCheck] = React.useState<{ key: string; result: SqlCheck } | null>(
    null,
  );
  const [result, setResult] = React.useState<{
    key: string;
    outcome: PanelQueryOutcome;
    at: number;
  } | null>(null);

  // Two presses in flight at once must not let the slower one win.
  const generation = React.useRef(0);
  const query = panel.query;
  const checkKey = checkSubject(query);
  const runKey = runSubject(query, timeRange);

  const validate = React.useCallback(() => {
    const seq = ++generation.current;
    setBusy("validate");
    void validatePanelSql({ sourceId: query.sourceId, sql: query.sql }).then((r) => {
      if (seq !== generation.current) return;
      setCheck({ key: checkKey, result: r });
      setBusy(null);
    });
  }, [query, checkKey]);

  const run = React.useCallback(() => {
    const seq = ++generation.current;
    setBusy("run");
    void runPanelQuery(query, timeRange).then((outcome) => {
      if (seq !== generation.current) return;
      setResult({ key: runKey, outcome, at: Date.now() });
      setBusy(null);
    });
  }, [query, runKey, timeRange]);

  const controller: PanelPreviewController = {
    busy,
    check: check && check.key === checkKey ? check.result : null,
    result: result && {
      outcome: result.outcome,
      stale: result.key !== runKey,
      at: result.at,
    },
    validate,
    run,
  };
  return controller;
}

export function PanelPreview({
  panel,
  preview,
}: {
  panel: Panel;
  preview: PanelPreviewController;
}) {
  const { busy, check, result } = preview;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={preview.validate}
          disabled={busy !== null}
        >
          {busy === "validate" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ShieldCheck className="h-3.5 w-3.5" />
          )}
          Validate
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={preview.run}
          disabled={busy !== null}
          title="Run preview (Ctrl/⌘ + Enter)"
        >
          {busy === "run" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          Run preview
        </Button>
        <span className="text-xs text-muted">
          Neither saves the dashboard. Ctrl/⌘ + Enter runs the preview.
        </span>
      </div>

      {check?.ok && (
        <p role="status" className="flex items-center gap-2 text-xs text-success">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          This SQL passes the guard for the selected source.
        </p>
      )}
      {check && !check.ok && (
        <ErrorDisplay
          error={check.error}
          onRetry={preview.validate}
          retryLabel="Validate again"
          disabled={busy !== null}
        />
      )}

      {result && (
        <div className="space-y-1">
          <div className="h-64">
            <PanelView panel={panel} state={previewState(result)} onRetry={preview.run} />
          </div>
          <p className="text-xs text-muted">
            {result.outcome.ok
              ? summarizeResult(result.outcome.rows.rows.length, result.outcome.elapsedMs)
              : "The query did not run."}
            {result.stale && " — the query has been edited since this ran."}
          </p>
        </div>
      )}
    </div>
  );
}

function previewState(result: NonNullable<PanelPreviewController["result"]>): PanelState {
  const { outcome, stale, at } = result;
  if (!outcome.ok) {
    return { data: EMPTY_ROWS, status: "error", error: outcome.error };
  }
  return { data: outcome.rows, status: stale ? "stale" : "live", updatedAt: at };
}
