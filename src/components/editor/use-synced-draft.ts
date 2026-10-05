"use client";

import * as React from "react";

/**
 * A draft that follows the spec. While the person edits, the draft is theirs
 * (a half-typed number, a step out of order, a variable with no name yet);
 * when the spec changes from anywhere else (undo, the JSON box, another
 * control) the draft is taken from it again. `committed` tells the hook what
 * the spec will now say, so its own commit is not mistaken for an outside
 * change.
 */
export function useSyncedDraft<D>(external: string, fromSpec: () => D) {
  const [draft, setDraft] = React.useState(fromSpec);
  const [seen, setSeen] = React.useState(external);
  if (external !== seen) {
    setSeen(external);
    setDraft(fromSpec());
  }
  return { draft, setDraft, committed: setSeen };
}
