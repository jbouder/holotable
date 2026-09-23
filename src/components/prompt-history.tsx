"use client";

import * as React from "react";
import { History, Trash2 } from "lucide-react";
import { type BrowserStorage, browserStorage } from "@/lib/browser-storage";
import {
  clearPromptHistory,
  promptHistoryKey,
  promptLabel,
  type PromptScope,
  type RememberedPrompt,
  prunePromptHistory,
  readPromptHistory,
  rememberPrompt,
} from "@/lib/prompt-history";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/menu";

/**
 * Recent prompts on a generation box (#83).
 *
 * A hook that owns the list plus the dropdown that shows it. The rules live in
 * `src/lib/prompt-history.ts` as pure functions; everything here is the React
 * plumbing around them — which storage, when to read, when to prune.
 */

export interface PromptHistory {
  entries: RememberedPrompt[];
  /** Record a prompt as it is submitted. Safe to call with an empty string. */
  remember: (prompt: string) => void;
  clear: () => void;
}

/**
 * The recent prompts for one workspace and one box.
 *
 * Reads after mount, never during render: `localStorage` does not exist on the
 * server, and a list rendered from it would be a hydration mismatch by
 * definition. Until the effect runs the list is empty, which is also what a
 * browser with no history shows — so there is nothing to flash.
 */
export function usePromptHistory(
  workspaceId: string | null | undefined,
  scope: PromptScope,
): PromptHistory {
  const [entries, setEntries] = React.useState<RememberedPrompt[]>([]);
  const storageRef = React.useRef<BrowserStorage | null>(null);

  React.useEffect(() => {
    const storage = browserStorage();
    storageRef.current = storage;
    // Each list is capped, but the number of lists is not: a browser that has
    // drifted through thirty workspaces would otherwise keep thirty forever.
    prunePromptHistory(storage, Date.now());
  }, []);

  React.useEffect(() => {
    if (!workspaceId) {
      setEntries([]);
      return;
    }
    setEntries(
      readPromptHistory(
        storageRef.current,
        promptHistoryKey(workspaceId, scope),
        Date.now(),
      ),
    );
  }, [workspaceId, scope]);

  const remember = React.useCallback(
    (prompt: string) => {
      if (!workspaceId) return;
      setEntries(
        rememberPrompt(
          storageRef.current,
          promptHistoryKey(workspaceId, scope),
          prompt,
          Date.now(),
        ),
      );
    },
    [workspaceId, scope],
  );

  const clear = React.useCallback(() => {
    if (!workspaceId) return;
    clearPromptHistory(storageRef.current, promptHistoryKey(workspaceId, scope));
    setEntries([]);
  }, [workspaceId, scope]);

  return { entries, remember, clear };
}

/**
 * The dropdown itself. Renders nothing when there is no history, so a first
 * visit is not given a control that opens onto an apology.
 *
 * Choosing an entry fills the box rather than submitting: re-use and edit are
 * the same gesture, and the author sees what is about to be sent.
 */
export function PromptHistoryMenu({
  history,
  onPick,
  disabled,
}: {
  history: PromptHistory;
  onPick: (prompt: string) => void;
  disabled?: boolean;
}) {
  if (history.entries.length === 0) return null;
  return (
    <Menu
      label="Recent prompts"
      panelClassName="max-w-md"
      trigger={<History className="h-4 w-4" />}
    >
      {history.entries.map((entry) => (
        <MenuItem
          key={entry.prompt}
          disabled={disabled}
          onClick={() => onPick(entry.prompt)}
        >
          <span className="truncate" title={entry.prompt}>
            {promptLabel(entry.prompt)}
          </span>
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem danger onClick={history.clear}>
        <Trash2 className="h-4 w-4" /> Clear recent prompts
      </MenuItem>
    </Menu>
  );
}
