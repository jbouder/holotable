import type { UIMessage } from "ai";
import {
  type Dashboard,
  hasQuery,
  type Panel,
  queryText,
  queryTimeField,
} from "@/lib/ir";
import { type Selection, selectionFromParams } from "@/lib/variable-selection";

/* -------------------------------------------------------------------------- */
/* The reader's view                                                          */
/* -------------------------------------------------------------------------- */

/** What a chat request says the reader is looking at (#366). */
export interface ChatViewRequest {
  timeRange?: { from: string; to: string };
  variables: Selection;
}

/**
 * The range and picks on screen, read from the dashboard's URL.
 *
 * `LiveDashboard` keeps the URL on the window being viewed and the picks
 * made (`from`/`to` only when they differ from the dashboard's own range), so
 * the URL is already the one place the view is written down. The server
 * checks all of it: the range is parsed as an IR time expression and resolved
 * there, and the picks go through the stream's allowlist.
 */
export function chatViewFromSearch(search: string): ChatViewRequest {
  const params = new URLSearchParams(search);
  const from = params.get("from");
  const to = params.get("to");
  return {
    ...(from && to ? { timeRange: { from, to } } : {}),
    variables: selectionFromParams(params),
  };
}

/**
 * The parts of dashboard chat that are not a model call.
 *
 * Persistence, citations and suggestion chips are all pure transformations over
 * a spec and a list of messages, so they live here and are tested as
 * functions. Nothing in this module talks to a model, a database or a browser.
 *
 * Read the stored side as untrusted. The rows were written by the server, but
 * `content` is opaque JSONB carrying an SDK shape that evolves, and a chat
 * message is the one place in the app where model-authored text is replayed
 * into a prompt — so what comes back out is shape-checked rather than cast.
 */

/** A message as it is stored: the SDK's own id and role, plus the whole message. */
export interface StoredChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: unknown;
  createdAt: string;
}

const ROLES = new Set(["user", "assistant", "system"]);

/**
 * A stored row as a `UIMessage`, or `null` if it is not one.
 *
 * A row that fails this is dropped rather than repaired: a half-understood
 * message replayed into a prompt is worse than a conversation that starts one
 * turn shorter.
 */
export function parseStoredMessage(row: StoredChatMessage): UIMessage | null {
  const content = row.content;
  if (typeof content !== "object" || content === null) return null;
  const parts = (content as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return null;
  if (!ROLES.has(row.role)) return null;
  return {
    ...(content as object),
    id: row.id,
    role: row.role,
    parts,
  } as UIMessage;
}

/** Every stored row that is a usable message, oldest first. */
export function parseStoredMessages(rows: StoredChatMessage[]): UIMessage[] {
  return rows
    .map(parseStoredMessage)
    .filter((message): message is UIMessage => message !== null);
}

/**
 * The messages worth writing for a finished turn.
 *
 * `onEnd` hands back the whole conversation, including everything that was
 * already stored, so this narrows it to the tail the turn actually produced.
 * Anything with no parts — an assistant message the model never got to start —
 * is not worth a row.
 */
export function messagesToPersist(
  messages: UIMessage[],
  alreadyStored: string[],
): UIMessage[] {
  const stored = new Set(alreadyStored);
  return messages.filter((m) => m.parts.length > 0 && !stored.has(m.id));
}

/* -------------------------------------------------------------------------- */
/* Citations                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A query the assistant actually ran, as the reader should see it.
 *
 * `sql` is what the model wrote. The statement the database saw also carries
 * the server's time-range predicate, which `buildExecutablePlan` added and no
 * part of this payload knows about — the footnote says so rather than showing
 * a statement that is not quite either one.
 */
export interface ChatCitation {
  sourceId: string;
  sql: string;
  /** Panels on this dashboard whose own query is the same statement. */
  panelTitles: string[];
  /**
   * The window the server narrowed the rows to (#366), as the time
   * expressions the reader picked. Absent on a query that failed, and on
   * answers stored before the server reported it.
   */
  timeRange?: { from: string; to: string };
  /** The variable values the statement was bound with, by name. */
  variables?: Record<string, string[]>;
}

/** The window and picks a tool result reports, when it reports them. */
function scopeFromOutput(output: unknown): Pick<ChatCitation, "timeRange" | "variables"> {
  if (typeof output !== "object" || output === null) return {};
  const { timeRange, variables } = output as { timeRange?: unknown; variables?: unknown };
  const out: Pick<ChatCitation, "timeRange" | "variables"> = {};
  if (
    typeof timeRange === "object" &&
    timeRange !== null &&
    typeof (timeRange as { from?: unknown }).from === "string" &&
    typeof (timeRange as { to?: unknown }).to === "string"
  ) {
    const { from, to } = timeRange as { from: string; to: string };
    out.timeRange = { from, to };
  }
  if (typeof variables === "object" && variables !== null) {
    const values: Record<string, string[]> = {};
    for (const [name, value] of Object.entries(variables)) {
      const list = [value].flat().filter((v): v is string => typeof v === "string");
      values[name] = list;
    }
    if (Object.keys(values).length > 0) out.variables = values;
  }
  return out;
}

/** Whitespace and case are not differences worth calling two statements apart. */
function normalizeSql(sql: string): string {
  return sql.trim().replace(/\s+/g, " ").replace(/;$/, "").toLowerCase();
}

/**
 * Which panels a query came from, if any.
 *
 * Matched on the source and the statement rather than on the source alone: a
 * dashboard usually has one source, so "this came from the same source as
 * every panel" is not a citation. A query the model composed itself simply
 * cites no panel, which is the honest answer.
 */
export function matchingPanels(
  panels: Pick<Panel, "title" | "query">[],
  sourceId: string,
  sql: string,
): string[] {
  const needle = normalizeSql(sql);
  // A text panel (#202) has no query, so nothing it said can be cited.
  return panels
    .filter(
      (p) =>
        p.query !== undefined &&
        p.query.sourceId === sourceId &&
        normalizeSql(queryText(p.query)) === needle,
    )
    .map((p) => p.title);
}

/**
 * The queries one assistant message ran.
 *
 * Read off the message's own `tool-runQuery` parts, which the SDK already
 * streams to the browser — no second request, and nothing the client is told
 * that it was not already holding. A call whose input never arrived (the turn
 * was stopped mid-stream) has nothing to cite and is skipped.
 */
export function citationsFromMessage(
  message: Pick<UIMessage, "parts">,
  panels: Pick<Panel, "title" | "query">[],
): ChatCitation[] {
  const citations: ChatCitation[] = [];
  for (const part of message.parts) {
    if (part.type !== "tool-runQuery") continue;
    const input = (part as { input?: unknown }).input;
    if (typeof input !== "object" || input === null) continue;
    const { sourceId, sql } = input as { sourceId?: unknown; sql?: unknown };
    if (typeof sourceId !== "string" || typeof sql !== "string") continue;
    if (!sourceId || !sql.trim()) continue;
    citations.push({
      sourceId,
      sql,
      panelTitles: matchingPanels(panels, sourceId, sql),
      ...scopeFromOutput((part as { output?: unknown }).output),
    });
  }
  return citations;
}

/* -------------------------------------------------------------------------- */
/* Suggested questions                                                        */
/* -------------------------------------------------------------------------- */

/** How many chips are offered. More than this is a menu, not a suggestion. */
export const MAX_SUGGESTIONS = 4;

/**
 * Questions worth asking about THIS dashboard, derived from the spec.
 *
 * Derived, never generated: a second model call to decide what to ask a model
 * costs a round trip and a budget entry to produce three sentences, and it
 * would be non-deterministic for no gain. The panel titles are the vocabulary
 * the author already chose, so the chips read like the dashboard.
 *
 * Titles come out of a stored spec, which an earlier model run wrote — so they
 * are inserted into a *question the user may send*, never into SQL and never
 * into the system prompt, where `sanitizePromptField` already handles them.
 */
export function chatSuggestions(dashboard: Dashboard): string[] {
  // A title only reaches a chip if it reads as one. A 200-character panel name
  // is legal in the IR and would make an unreadable question, so it is left
  // out rather than truncated into half a sentence.
  // A text panel (#202) has no data to ask about.
  const nameable = dashboard.panels
    .filter(hasQuery)
    .filter((p) => p.title.trim().length > 0 && p.title.trim().length <= 60);
  const name = (p: Pick<Panel, "title">) => p.title.trim();

  const suggestions = ["Summarize what this dashboard is showing right now."];

  const timeSeries = nameable.find(
    (p) => queryTimeField(p.query) && (p.viz === "line" || p.viz === "area"),
  );
  if (timeSeries) {
    suggestions.push(`Has "${name(timeSeries)}" changed over this window?`);
  }

  if (nameable.length > 1) {
    suggestions.push("Which panel looks the most unusual, and why?");
  }

  const stat = nameable.find((p) => p.viz === "stat");
  if (stat) {
    suggestions.push(`What is behind the "${name(stat)}" number?`);
  } else if (nameable[0] && nameable[0] !== timeSeries) {
    suggestions.push(`What is the highest value in "${name(nameable[0])}"?`);
  }

  // Deduplicate: a one-panel dashboard can produce the same question twice.
  return [...new Set(suggestions)].slice(0, MAX_SUGGESTIONS);
}

/**
 * Questions about ONE panel, for a chat opened from its menu (#366). Derived
 * the same way and for the same reasons as {@link chatSuggestions}; a title
 * too long to read as part of a question is called "this panel".
 */
export function panelChatSuggestions(
  panel: Pick<Panel, "title" | "viz" | "query">,
): string[] {
  const title = panel.title.trim();
  const name = title.length > 0 && title.length <= 60 ? `"${title}"` : "this panel";
  if (!panel.query) return [`What does ${name} say?`];
  const suggestions = [`Explain what ${name} shows and how it is calculated.`];
  if (queryTimeField(panel.query) && (panel.viz === "line" || panel.viz === "area")) {
    suggestions.push(`Has ${name} changed over this window?`);
    suggestions.push(`When was ${name} at its highest?`);
  } else if (panel.viz === "stat" || panel.viz === "gauge") {
    suggestions.push(`What is behind the ${name} number?`);
  } else {
    suggestions.push(`What stands out in ${name}?`);
  }
  return suggestions.slice(0, MAX_SUGGESTIONS);
}
