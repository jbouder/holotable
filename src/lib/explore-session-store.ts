import { z } from "zod";
import { ExplorePanel, hasQuery, type QueryPanel, VizType } from "@/lib/ir";
import { MAX_SESSION_ENTRIES } from "@/lib/explore-session";
import {
  initialTableView,
  initialView,
  type TableView,
  type ViewSettings,
  viewPanel,
} from "@/lib/explore-view";
import { PROMPT_MAX_LENGTH } from "@/lib/prompt-history";

/**
 * Keeping an Explore session across a reload of the tab, when the person asks
 * for it in Preferences.
 *
 * Browser-safe and pure. What is kept is the questions and how each answer was
 * drawn, never the rows: on the way back every panel is re-validated as an IR
 * panel and its query re-run through the guarded route, under a window the
 * server resolves, exactly as a fresh answer would be. It lives in
 * `sessionStorage`, so it is one tab's and ends with it, and it carries the
 * subject it was written for, so a different person signing in to the same
 * tab starts empty.
 */

export const EXPLORE_SESSION_KEY = "holotable:explore-session";

/** What is kept of one answer. */
export interface StoredEntry {
  prompt: string;
  askedAt: number;
  sourceName: string;
  workspaceId: string;
  from: string;
  panel: QueryPanel;
  view: ViewSettings;
  table: TableView;
}

/** A restored session: entries newest first, and which were shown and pinned. */
export interface StoredSession {
  entries: StoredEntry[];
  activeIndex: number | null;
  pinnedIndex: number | null;
}

const Text = (max: number) => z.string().min(1).max(max);

const ViewShape = z.object({
  viz: VizType,
  legend: z.boolean(),
  stacked: z.boolean(),
  log: z.boolean(),
});

const TableShape = z.object({
  hidden: z.array(Text(128)).max(50),
  sort: z.object({ column: Text(128), order: z.enum(["asc", "desc"]) }).nullable(),
});

const EntryShape = z.object({
  prompt: Text(PROMPT_MAX_LENGTH),
  askedAt: z.number().int().nonnegative(),
  sourceName: Text(200),
  workspaceId: Text(200),
  from: Text(64),
  panel: z.unknown(),
  view: z.unknown(),
  table: z.unknown(),
});

const SessionShape = z.object({
  v: z.literal(1),
  sub: Text(256),
  activeIndex: z.number().int().nonnegative().nullable(),
  pinnedIndex: z.number().int().nonnegative().nullable(),
  entries: z.array(z.unknown()).max(MAX_SESSION_ENTRIES),
});

/** The session as text to keep, for this subject. */
export function serializeSession(sub: string, session: StoredSession): string {
  return JSON.stringify({ v: 1, sub, ...session });
}

/** One kept answer back, or null if any part of it is not what it claims. */
function restoreEntry(raw: unknown): StoredEntry | null {
  const shape = EntryShape.safeParse(raw);
  if (!shape.success) return null;
  const parsed = ExplorePanel.safeParse(shape.data.panel);
  if (!parsed.success || !hasQuery(parsed.data)) return null;
  const panel = parsed.data as QueryPanel;
  // A view or table that no longer makes a valid panel falls back to the
  // model's own, rather than costing the whole answer.
  const view = ViewShape.safeParse(shape.data.view);
  const table = TableShape.safeParse(shape.data.table);
  const keptView = view.success ? view.data : initialView(panel);
  const keptTable = table.success ? table.data : initialTableView(panel);
  const valid = viewPanel(panel, keptView, keptTable) !== null;
  return {
    prompt: shape.data.prompt,
    askedAt: shape.data.askedAt,
    sourceName: shape.data.sourceName,
    workspaceId: shape.data.workspaceId,
    from: shape.data.from,
    panel,
    view: valid ? keptView : initialView(panel),
    table: valid ? keptTable : initialTableView(panel),
  };
}

/**
 * The kept session for this subject, or null: nothing kept, someone else's,
 * or not parseable. Never throws. Entries that fail are dropped, and the
 * shown and pinned indexes are kept only if they still point at one.
 */
export function parseStoredSession(
  raw: string | null | undefined,
  sub: string,
): StoredSession | null {
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const session = SessionShape.safeParse(json);
  if (!session.success || session.data.sub !== sub) return null;
  // Indexes refer to the stored list, so map them across the entries kept.
  const kept: StoredEntry[] = [];
  const indexOf = new Map<number, number>();
  session.data.entries.forEach((raw, i) => {
    const entry = restoreEntry(raw);
    if (entry) {
      indexOf.set(i, kept.length);
      kept.push(entry);
    }
  });
  if (kept.length === 0) return null;
  const at = (i: number | null) => (i === null ? null : (indexOf.get(i) ?? null));
  return {
    entries: kept,
    activeIndex: at(session.data.activeIndex) ?? 0,
    pinnedIndex: at(session.data.pinnedIndex),
  };
}

/** This tab's `sessionStorage`, or null where it is missing or refused. */
export function tabStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Read the kept session from storage; never throws. */
export function readStoredSession(
  storage: Pick<Storage, "getItem"> | null,
  sub: string,
): StoredSession | null {
  try {
    return parseStoredSession(storage?.getItem(EXPLORE_SESSION_KEY), sub);
  } catch {
    return null;
  }
}

/** Keep the session, or forget it when there is nothing to keep; never throws. */
export function writeStoredSession(
  storage: Pick<Storage, "setItem" | "removeItem"> | null,
  sub: string,
  session: StoredSession | null,
): void {
  try {
    if (!session || session.entries.length === 0) {
      storage?.removeItem(EXPLORE_SESSION_KEY);
    } else {
      storage?.setItem(EXPLORE_SESSION_KEY, serializeSession(sub, session));
    }
  } catch {
    // A full quota or disabled storage: the session simply does not survive.
  }
}
