import type { UIMessage } from "ai";
import { parseStoredMessage, type StoredChatMessage } from "@/lib/chat-history";
import {
  chatPanelSpec,
  modelOutputOf,
  panelIdOf,
  SHOW_PANEL_PART,
} from "@/lib/chat/panel";

/**
 * What a conversation stores of a message, and how it is read back (#416).
 *
 * A drawn panel's result rows are never stored: they reached the browser on
 * the stream, and the page re-runs the panel from its spec after a reload. A
 * stored `showPanel` part keeps its input (the IR panel spec the model wrote)
 * and the model-facing output (the panel id, columns, row count and a few
 * sample rows), so a row is bounded whatever the panel returned.
 */

/** Shown in place of a stored panel this build can no longer draw. */
export const PANEL_UNAVAILABLE = "this panel can no longer be drawn";

type ToolPart = {
  type: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

/** The message as it is written: every drawn panel's output reduced. */
export function persistableMessage(message: UIMessage): UIMessage {
  return {
    ...message,
    parts: message.parts.map((part) => {
      const p = part as ToolPart;
      if (p.type !== SHOW_PANEL_PART || p.state !== "output-available") return part;
      return { ...part, output: modelOutputOf(p.output) } as UIMessage["parts"][number];
    }),
  };
}

/**
 * A stored row read back as a message, untrusted like any stored content.
 * A `showPanel` part whose spec no longer reads as a panel, or that never
 * finished, becomes an error part rather than disappearing, since the prose
 * around it may refer to it.
 */
export function readStoredChatMessage(row: StoredChatMessage): UIMessage | null {
  const message = parseStoredMessage(row);
  if (!message) return null;
  return {
    ...message,
    parts: message.parts.map((part) => {
      const p = part as ToolPart;
      if (p.type !== SHOW_PANEL_PART) return part;
      const output = p.state === "output-available" ? modelOutputOf(p.output) : null;
      if (p.state === "output-error" && typeof p.errorText === "string") return part;
      if (output && !output.ok) return { ...part, output } as UIMessage["parts"][number];
      const panelId = output ? panelIdOf({ output }) : undefined;
      if (output && panelId && chatPanelSpec(p.input, panelId)) {
        return { ...part, output } as UIMessage["parts"][number];
      }
      return {
        ...part,
        state: "output-error",
        output: undefined,
        errorText: PANEL_UNAVAILABLE,
      } as UIMessage["parts"][number];
    }),
  };
}
