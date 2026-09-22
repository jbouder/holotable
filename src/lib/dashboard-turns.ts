import type { Dashboard } from "@/lib/ir";
import { autoLayoutPanels, DEFAULT_COLUMNS } from "@/lib/layout";

/**
 * Turn history for conversational refinement on /dashboards/new.
 *
 * Generation used to be one-shot: the only way to change anything was to
 * rewrite the prompt and regenerate from scratch. A follow-up instead sends the
 * current spec back as context and gets a full updated dashboard — one model
 * call per turn, so the runs-once-per-author-action rule still holds.
 *
 * The history is entirely client-side and unsaved; nothing here persists
 * anything. It is plain bookkeeping over a list, so it lives in `lib/` as pure
 * functions rather than inside the page component.
 */

/** A generated turn before it joins a history and is given its id. */
export interface TurnDraft {
  /** The instruction the author typed for this turn. */
  prompt: string;
  /** The full spec the model returned, layout-normalized. */
  spec: Dashboard;
}

export interface DashboardTurn extends TurnDraft {
  /** Stable across restores and truncation, so React keys stay honest. */
  id: string;
}

/** Turns plus the one currently previewed. `index` is -1 when there are none. */
export interface TurnHistory {
  turns: DashboardTurn[];
  index: number;
  /** Counter behind turn ids; monotonic so a truncated id is never reused. */
  nextId: number;
}

export const EMPTY_HISTORY: TurnHistory = { turns: [], index: -1, nextId: 1 };

/**
 * Normalize a freshly generated spec the way the initial generation does: the
 * model's raw {x,y,w,h} guesses often overlap, so panels are re-flowed two-up.
 */
export function normalizeTurn(prompt: string, spec: Dashboard): TurnDraft {
  return {
    prompt,
    spec: { ...spec, panels: autoLayoutPanels(spec.panels, DEFAULT_COLUMNS) },
  };
}

/**
 * Record a turn after the active one, dropping any turn that followed it.
 * Stepping back and refining branches from that point rather than leaving
 * orphaned turns the author can no longer reach.
 */
export function appendTurn(history: TurnHistory, draft: TurnDraft): TurnHistory {
  const kept = history.turns.slice(0, history.index + 1);
  return {
    turns: [...kept, { ...draft, id: `turn-${history.nextId}` }],
    index: kept.length,
    nextId: history.nextId + 1,
  };
}

/** Preview an earlier turn. An out-of-range index leaves the history alone. */
export function restoreTurn(history: TurnHistory, index: number): TurnHistory {
  if (index < 0 || index >= history.turns.length) return history;
  return { ...history, index };
}

/** The spec to preview, refine from, and save — null before the first turn. */
export function activeSpec(history: TurnHistory): Dashboard | null {
  return history.turns[history.index]?.spec ?? null;
}
