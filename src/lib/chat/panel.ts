import type { UIMessage } from "ai";
import { ExplorePanelAnyLanguage, type PanelLayout, type QueryPanel } from "@/lib/ir";

/**
 * A panel drawn in a Chat answer (#416), as the browser, the store and the
 * model each see it. Browser-safe: the engine that draws one is
 * `src/lib/ai/data-chat.ts`.
 */

/** The rows of a drawn panel the model is shown: enough to narrate, no more. */
export const MAX_SAMPLE_ROWS = 5;

/** Where an inline panel sits: alone, full width. The server assigns it. */
export const CHAT_PANEL_LAYOUT: PanelLayout = { x: 0, y: 0, w: 12, h: 4 };

/** The tool part type a drawn panel streams as. */
export const SHOW_PANEL_PART = "tool-showPanel";

/** A drawn panel, as the browser receives it: the spec and the rows it ran to. */
export type ShownPanel = {
  ok: true;
  panelId: string;
  spec: QueryPanel;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  /** The window the server resolved for these rows, in epoch ms. */
  window: { from: number; to: number };
};

/** A panel the server would not draw, and why: the model may correct it. */
export type RefusedPanel = {
  ok: false;
  error: string;
};

export type ShowPanelOutput = ShownPanel | RefusedPanel;

/**
 * What the model is told about a drawn panel: its shape and a few rows, never
 * the result set. This is also what a conversation stores, so a stored
 * message is bounded whatever the panel returned.
 */
export type ShowPanelModelOutput =
  | {
      ok: true;
      panelId: string;
      columns: string[];
      rowCount: number;
      sample: Record<string, unknown>[];
    }
  | RefusedPanel;

/**
 * A `showPanel` output as the model sees it. Takes either form, so an output
 * already reduced (a stored message read back) reduces to itself.
 */
export function modelOutputOf(output: unknown): ShowPanelModelOutput {
  const o = (typeof output === "object" && output !== null ? output : {}) as Record<
    string,
    unknown
  >;
  if (o.ok !== true || typeof o.panelId !== "string") {
    return {
      ok: false,
      error: typeof o.error === "string" ? o.error : "the panel was not drawn",
    };
  }
  const rows = Array.isArray(o.sample) ? o.sample : Array.isArray(o.rows) ? o.rows : [];
  return {
    ok: true,
    panelId: o.panelId,
    columns: Array.isArray(o.columns)
      ? o.columns.filter((c): c is string => typeof c === "string")
      : [],
    rowCount: typeof o.rowCount === "number" ? o.rowCount : rows.length,
    sample: rows.slice(0, MAX_SAMPLE_ROWS) as Record<string, unknown>[],
  };
}

/**
 * The full panel a `showPanel` input becomes once the server gives it an id
 * and a place, read through the IR. Null when it is not a panel this build
 * would draw, which is what a stored spec from an older build can be.
 */
export function chatPanelSpec(input: unknown, panelId: string): QueryPanel | null {
  if (typeof input !== "object" || input === null) return null;
  const parsed = ExplorePanelAnyLanguage.safeParse({
    ...input,
    id: panelId,
    layout: CHAT_PANEL_LAYOUT,
  });
  return parsed.success ? (parsed.data as QueryPanel) : null;
}

/** The panel id a `showPanel` part's output carries, if any. */
export function panelIdOf(part: { output?: unknown }): string | undefined {
  const id = (part.output as { panelId?: unknown } | undefined)?.panelId;
  return typeof id === "string" ? id : undefined;
}

/**
 * The next free panel number in a conversation: one past the highest `p<n>`
 * any earlier `showPanel` output carries, so ids stay unique across turns.
 */
export function nextPanelNumber(messages: readonly UIMessage[]): number {
  let highest = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== SHOW_PANEL_PART) continue;
      const n = /^p(\d{1,6})$/.exec(panelIdOf(part as { output?: unknown }) ?? "")?.[1];
      if (n) highest = Math.max(highest, Number(n));
    }
  }
  return highest + 1;
}
