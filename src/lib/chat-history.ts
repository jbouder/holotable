import type { UIMessage } from "ai";
import type { Dashboard, Panel } from "@/lib/ir";

/**
 * The parts of dashboard chat that are not a model call.
 *
 * Persistence, citations and follow-up chips are all pure transformations over
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
  return panels
    .filter((p) => p.query.sourceId === sourceId && normalizeSql(p.query.sql) === needle)
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
    });
  }
  return citations;
}

/* -------------------------------------------------------------------------- */
/* Suggested follow-ups                                                       */
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
  const nameable = dashboard.panels.filter(
    (p) => p.title.trim().length > 0 && p.title.trim().length <= 60,
  );
  const name = (p: Panel) => p.title.trim();

  const suggestions = ["Summarize what this dashboard is showing right now."];

  const timeSeries = nameable.find(
    (p) => p.query.timeField && (p.viz === "line" || p.viz === "area"),
  );
  if (timeSeries) {
    suggestions.push(`Has "${name(timeSeries)}" changed over this window?`);
  }

  if (dashboard.panels.length > 1) {
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
