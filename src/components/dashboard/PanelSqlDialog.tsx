"use client";

import * as React from "react";
import { Check, Code, Copy } from "lucide-react";
import type { Panel, TimeRange } from "@/lib/ir";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { panelDetails } from "@/lib/panel-details";
import { QueryPlanSection } from "@/components/sql/QueryPlanSection";

const COPIED_RESET_MS = 2_000;

/**
 * Viewer-side "how was this computed?" affordance. The SQL, source id and time
 * field are already in the spec the client holds, so this reveals nothing new —
 * it just stops the editor being the only place to see it.
 */
export function PanelSqlDialog({
  panel,
  timeRange,
}: {
  panel: Panel;
  /** Enables the "what actually runs" section; absent on surfaces with no window. */
  timeRange?: TimeRange;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <Button
        aria-label={`Show generated SQL for ${panel.title}`}
        className="h-7 w-7 text-muted"
        onClick={() => setOpen(true)}
        size="icon"
        variant="ghost"
      >
        <Code className="h-4 w-4" />
      </Button>
      <Dialog onOpenChange={setOpen} open={open} title="Generated SQL">
        <PanelSqlBody panel={panel} timeRange={timeRange} />
      </Dialog>
    </>
  );
}

function PanelSqlBody({ panel, timeRange }: { panel: Panel; timeRange?: TimeRange }) {
  const details = panelDetails(panel);
  const [copied, setCopied] = React.useState(false);
  const [copyFailed, setCopyFailed] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  // `navigator.clipboard` is absent outside a secure context, so the property
  // access itself can throw. Both failure modes land in the same notice.
  async function copy() {
    try {
      await navigator.clipboard.writeText(details.sql);
      setCopyFailed(false);
      setCopied(true);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  }

  return (
    <div className="space-y-4">
      <h4 className="text-sm font-medium">{panel.title}</h4>
      {details.description && <p className="text-sm text-muted">{details.description}</p>}

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted">Source</dt>
        <dd className="truncate font-mono">{details.sourceId}</dd>
        <dt className="text-muted">Time field</dt>
        <dd className="truncate font-mono">{details.timeField ?? "—"}</dd>
      </dl>

      <div className="rounded-lg border border-border bg-surface-2">
        <div className="flex items-center justify-between gap-4 border-b border-border px-3 py-2">
          <span className="text-xs font-medium text-muted">SQL</span>
          <Button onClick={() => void copy()} size="sm" variant="secondary">
            {copied ? (
              <Check className="h-3.5 w-3.5 text-success" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
          </Button>
        </div>
        <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words px-3 py-3 font-mono text-xs leading-relaxed">
          {details.sql}
        </pre>
      </div>

      {copyFailed && (
        <p className="text-xs text-danger">
          Could not reach the clipboard. Select the statement above and copy it manually.
        </p>
      )}

      <p className="text-xs text-muted">
        The dashboard time range is applied by the server at execution time and is not
        part of this statement.
      </p>

      {timeRange && <QueryPlanSection query={panel.query} timeRange={timeRange} />}
    </div>
  );
}
