"use client";

import * as React from "react";

/**
 * Undo/redo for the dashboard editor (#81).
 *
 * The editor held the whole spec in one `useState`, so an accidental delete, a
 * mistaken `Arrange: 4-up` or an unwanted natural-language edit was
 * unrecoverable — the only way back was to abandon the session without saving.
 *
 * The state machine below is a plain reducer over `{past, present, future}` and
 * carries no React: every rule that matters (coalescing, the bound on the
 * stack, redo being cleared by a new action) is a pure function of the previous
 * history, the new value and `now`, and is tested as one in
 * `test/editor-history.test.ts`. {@link useHistory} is the thin hook the editor
 * actually uses.
 *
 * Two properties are load-bearing:
 *
 * - **Coalescing.** A burst of keystrokes in a text field must be one entry,
 *   not one per character, or the bounded stack fills with a single word. Two
 *   pushes merge when they carry the same `key` and land within
 *   {@link COALESCE_WINDOW_MS} of each other; a different field, or a pause,
 *   starts a new entry.
 * - **Boundedness.** `past` never grows beyond `limit`, so a long session
 *   cannot retain every intermediate spec.
 */

export interface HistoryEntry<T> {
  value: T;
  /** Human description of the action that produced `value`, for the tooltip. */
  action: string;
  /** Coalescing key: consecutive pushes sharing one merge. Null never merges. */
  key: string | null;
  /** When the entry was pushed, in epoch ms. Injected, never read from a clock. */
  at: number;
}

export interface History<T> {
  past: HistoryEntry<T>[];
  present: HistoryEntry<T>;
  future: HistoryEntry<T>[];
}

/** Entries kept behind the present. Beyond this the oldest is dropped. */
export const HISTORY_LIMIT = 50;

/** Two pushes with the same key merge when they land within this window. */
export const COALESCE_WINDOW_MS = 1_000;

export interface PushOptions {
  /** Human description of what is being done, e.g. "edit panel title". */
  action: string;
  /** Coalescing key; omit (or pass null) for an action that always stands alone. */
  key?: string | null;
  /** Epoch ms for the push. */
  at: number;
  limit?: number;
}

export function initHistory<T>(present: T): History<T> {
  return {
    past: [],
    // The initial entry has no key, so the first real edit can never merge into
    // the state the editor opened with — undoing back to it must stay possible.
    present: { value: present, action: "open", key: null, at: 0 },
    future: [],
  };
}

export function pushHistory<T>(
  history: History<T>,
  value: T,
  options: PushOptions,
): History<T> {
  const limit = options.limit ?? HISTORY_LIMIT;
  const key = options.key ?? null;
  const entry: HistoryEntry<T> = { value, action: options.action, key, at: options.at };

  const merges =
    key !== null &&
    history.present.key === key &&
    options.at - history.present.at <= COALESCE_WINDOW_MS;

  if (merges) {
    // The merged entry keeps the ORIGINAL timestamp, so a continuous stream of
    // keystrokes cannot extend the window indefinitely and swallow a later,
    // genuinely separate edit to the same field.
    return {
      past: history.past,
      present: { ...entry, at: history.present.at },
      future: [],
    };
  }

  const past = [...history.past, history.present];
  return {
    past: past.length > limit ? past.slice(past.length - limit) : past,
    present: entry,
    // A new action after an undo abandons the redo branch.
    future: [],
  };
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0;
}

export function undoHistory<T>(history: History<T>): History<T> {
  const previous = history.past[history.past.length - 1];
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redoHistory<T>(history: History<T>): History<T> {
  const next = history.future[0];
  if (!next) return history;
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  };
}

/** What an Undo would take back, for the button's tooltip. */
export function undoAction<T>(history: History<T>): string | null {
  return canUndo(history) ? history.present.action : null;
}

/** What a Redo would re-apply. */
export function redoAction<T>(history: History<T>): string | null {
  return history.future[0]?.action ?? null;
}

export interface UseHistory<T> {
  state: T;
  /** Replace the state, recording an entry. */
  set: (next: T | ((current: T) => T), options: Omit<PushOptions, "at">) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  undoAction: string | null;
  redoAction: string | null;
}

export function useHistory<T>(initial: T, limit = HISTORY_LIMIT): UseHistory<T> {
  const [history, setHistory] = React.useState<History<T>>(() => initHistory(initial));

  const set = React.useCallback(
    (next: T | ((current: T) => T), options: Omit<PushOptions, "at">) => {
      setHistory((h) => {
        const value =
          typeof next === "function" ? (next as (c: T) => T)(h.present.value) : next;
        return pushHistory(h, value, { ...options, at: Date.now(), limit });
      });
    },
    [limit],
  );

  const undo = React.useCallback(() => setHistory(undoHistory), []);
  const redo = React.useCallback(() => setHistory(redoHistory), []);

  return {
    state: history.present.value,
    set,
    undo,
    redo,
    canUndo: canUndo(history),
    canRedo: canRedo(history),
    undoAction: undoAction(history),
    redoAction: redoAction(history),
  };
}
