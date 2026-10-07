"use client";

import * as React from "react";
import type { Dashboard, QueryPanel } from "@/lib/ir";
import { panelTimeRange } from "@/lib/ir";
import type { PanelState } from "@/components/dashboard/PanelView";
import { EMPTY_ROWS, runPanelQuery } from "@/lib/panel-query";
import { panelsToRun, previewRunKey } from "@/lib/preview-runs";
import type { VariableValues } from "@/lib/sql/variables";

/**
 * One-shot results for every panel of a spec that is being looked at before
 * it is saved: each panel's guarded query, run through `/api/query`.
 *
 * A panel runs again only when its query, its window or the bound variable
 * values change (`panelsToRun`), after `debounceMs` of quiet, so typing SQL in
 * the editor is one request when the author pauses rather than one per key. A
 * result that arrives after its panel changed again is dropped: it answers a
 * query that is no longer on screen.
 */
export function usePreviewStates(
  spec: Dashboard,
  variables: { values: VariableValues; ready: boolean },
  { debounceMs = 0 }: { debounceMs?: number } = {},
): { states: Record<string, PanelState>; retry: (panel: QueryPanel) => void } {
  const [states, setStates] = React.useState<Record<string, PanelState>>({});
  /** The key each panel's current (or in-flight) result was asked for with. */
  const lastRun = React.useRef<Record<string, string>>({});
  const { values, ready } = variables;

  const run = React.useCallback(
    async (panel: QueryPanel, key: string, range: Dashboard["timeRange"]) => {
      lastRun.current[panel.id] = key;
      setStates((s) => ({
        ...s,
        [panel.id]: { data: s[panel.id]?.data ?? EMPTY_ROWS, status: "loading" },
      }));
      // A panel with its own window (#114) is previewed over it.
      const outcome = await runPanelQuery(panel.query, panelTimeRange(panel, range), {
        variables: values,
      });
      if (lastRun.current[panel.id] !== key) return;
      setStates((s) => ({
        ...s,
        [panel.id]: outcome.ok
          ? { data: outcome.rows, status: "live", updatedAt: Date.now() }
          : { data: EMPTY_ROWS, status: "error", error: outcome.error },
      }));
    },
    [values],
  );

  // `spec` is a fresh object on every render; what decides whether anything
  // runs is the set of keys, so that is the dependency.
  const pending = ready
    ? panelsToRun(spec.panels, spec.timeRange, values, lastRun.current)
    : [];
  const signature = pending.map((p) => `${p.panel.id}=${p.key}`).join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the pending runs on purpose
  React.useEffect(() => {
    if (!signature) return;
    const timer = setTimeout(() => {
      for (const { panel, key } of pending) void run(panel, key, spec.timeRange);
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [signature, run, debounceMs]);

  const retry = React.useCallback(
    (panel: QueryPanel) =>
      void run(panel, previewRunKey(panel, spec.timeRange, values), spec.timeRange),
    [run, spec.timeRange, values],
  );

  return { states, retry };
}
