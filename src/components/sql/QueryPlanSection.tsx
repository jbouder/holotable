"use client";

import * as React from "react";
import { FileCode2, Loader2 } from "lucide-react";
import type { PanelQuery, TimeRange } from "@/lib/ir";
import { Button } from "@/components/ui/button";
import { ErrorDisplay } from "@/components/ui/error-display";
import { fetchQueryPlan, type PlanOutcome } from "@/lib/query-plan";
import { QueryPlanView } from "@/components/sql/QueryPlanView";

/**
 * "What actually runs", on demand.
 *
 * Fetched rather than rendered with the dialog: it costs a round trip, most
 * openings of this dialog are to read the SQL, and the answer depends on the
 * window at the moment it is asked for. A reader who may not preview queries
 * on this source gets the guard's own refusal rather than a section that
 * quietly is not there.
 */
export function QueryPlanSection({
  query,
  timeRange,
}: {
  query: PanelQuery;
  timeRange: TimeRange;
}) {
  const [busy, setBusy] = React.useState(false);
  const [outcome, setOutcome] = React.useState<PlanOutcome | null>(null);

  const load = React.useCallback(() => {
    setBusy(true);
    void fetchQueryPlan(query, timeRange).then((next) => {
      setOutcome(next);
      setBusy(false);
    });
  }, [query, timeRange]);

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm font-medium">What actually runs</span>
        {outcome === null && (
          <Button disabled={busy} onClick={load} size="sm" variant="secondary">
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileCode2 className="h-3.5 w-3.5" />
            )}
            Show
          </Button>
        )}
      </div>
      {outcome?.ok && <QueryPlanView plan={outcome.plan} />}
      {outcome && !outcome.ok && (
        <ErrorDisplay error={outcome.error} onRetry={load} retryLabel="Try again" />
      )}
    </div>
  );
}
