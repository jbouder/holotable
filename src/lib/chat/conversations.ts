import type { UIMessage } from "ai";
import { z } from "zod";
import { assertAuthorized, can, HttpError } from "@/lib/auth/authorize";
import type { Identity } from "@/lib/auth/claims";
import { type ChatExecutor, type ChatScope, planChatQuery } from "@/lib/ai/data-chat";
import { MAX_GENERATION_SOURCES } from "@/lib/ai/generate";
import type {
  Conversation,
  ConversationRetention,
  ConversationStore,
} from "@/lib/db/conversations";
import { chatPanelSpec, panelIdOf, SHOW_PANEL_PART } from "@/lib/chat/panel";
import { config } from "@/lib/config";
import { type QueryPanel, SqlQuery, TimeRange } from "@/lib/ir";
import type { SourceRecord } from "@/lib/registry";
import { QueryExecutionError } from "@/lib/sources/execution";
import { serverKind } from "@/lib/sources/server/registry";
import { resolveTimeRange } from "@/lib/time";

/**
 * What the `/api/chat` routes decide (#416), apart from the HTTP: which
 * sources a conversation may use, what a turn is sent, and how a stored
 * panel runs again. The routes are thin over this, and the tests drive it
 * with fakes.
 */

/** The most sources one conversation may use: a generation's bound (#104). */
export const MAX_CHAT_SOURCES = MAX_GENERATION_SOURCES;

/** Conversations in one page of the history list. */
export const CONVERSATIONS_PAGE = 50;

/** The longest question a turn takes. */
export const MAX_QUESTION_CHARS = 4_000;

/** The longest title, derived or typed. */
export const MAX_TITLE_CHARS = 80;

export const SourceIds = z
  .array(SqlQuery.shape.sourceId)
  .min(1)
  .max(MAX_CHAT_SOURCES)
  .refine((ids) => new Set(ids).size === ids.length, "a source is listed twice");

export const ConversationId = z.uuid();

/** `p<n>`, as the engine numbers a conversation's panels. */
export const PanelId = z.string().regex(/^p\d{1,6}$/);

export const Title = z.string().trim().min(1).max(MAX_TITLE_CHARS);

/**
 * What a panel run is sent: a window, and nothing else. The statement is the
 * stored panel's, read on the server; a browser never sends SQL or PromQL to
 * run (#416).
 */
export const PanelRunBody = z.object({ timeRange: TimeRange.optional() }).strict();

/**
 * One turn's question. Only the new user message is taken from the browser:
 * the history the model sees is the stored conversation, so nothing an
 * earlier answer said can be rewritten from the client.
 */
export const TurnBody = z.object({
  message: z.object({
    id: z.string().min(1).max(128),
    role: z.literal("user"),
    parts: z
      .array(z.object({ type: z.literal("text"), text: z.string().min(1) }))
      .min(1)
      .max(10)
      .refine(
        (parts) => parts.reduce((n, p) => n + p.text.length, 0) <= MAX_QUESTION_CHARS,
        `a question is at most ${MAX_QUESTION_CHARS} characters`,
      ),
  }),
});
export type TurnBody = z.infer<typeof TurnBody>;

export function conversationRetention(): ConversationRetention {
  return {
    limit: config.chatHistoryMaxMessages,
    retentionDays: config.chatHistoryRetentionDays,
  };
}

/** The title a conversation takes from its first question: no model call. */
export function conversationTitle(message: Pick<UIMessage, "parts">): string | undefined {
  const text = message.parts
    .map((p) => (p.type === "text" ? p.text : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > MAX_TITLE_CHARS ? `${text.slice(0, MAX_TITLE_CHARS - 1)}…` : text;
}

type GetSource = (id: string) => Promise<SourceRecord | null>;

/**
 * The sources a conversation is made with, or changed to, all checked: each
 * exists, is live, may be used by the caller, and all are in one workspace,
 * which becomes the conversation's. The workspace comes from the trusted
 * records, never from the request. A refusal names the first problem.
 */
export async function requestedSources(input: {
  identity: Identity;
  sourceIds: readonly string[];
  getSource: GetSource;
  /** When changing a conversation's sources: the workspace it must stay in. */
  workspaceId?: string;
}): Promise<{ workspaceId: string; sources: SourceRecord[] }> {
  const sources: SourceRecord[] = [];
  for (const id of input.sourceIds) {
    const source = await input.getSource(id);
    if (!source || source.tombstonedAt) {
      throw new HttpError(400, `unknown or removed source "${id}"`, {}, "validation");
    }
    assertAuthorized(
      input.identity,
      "source:use",
      { workspaceId: source.workspaceId },
      { type: "source", id: source.id },
    );
    sources.push(source);
  }
  const workspaces = new Set(sources.map((s) => s.workspaceId));
  const [workspaceId] = workspaces;
  if (workspaces.size !== 1 || workspaceId === undefined) {
    throw new HttpError(
      400,
      "a conversation uses sources from one workspace; start a new conversation for another",
      {},
      "validation",
    );
  }
  if (input.workspaceId !== undefined && input.workspaceId !== workspaceId) {
    throw new HttpError(
      400,
      "these sources are in another workspace; start a new conversation for them",
      {},
      "validation",
    );
  }
  return { workspaceId, sources };
}

/**
 * The conversation's sources the caller may still use, re-resolved now: a
 * source that is gone, tombstoned, moved out of the conversation's workspace
 * or no longer usable is left out and named in `unavailable`. With none left
 * the conversation is read-only, not gone.
 */
export async function usableSources(input: {
  identity: Identity;
  conversation: Pick<Conversation, "sourceIds" | "workspaceId">;
  getSource: GetSource;
}): Promise<{ sources: SourceRecord[]; unavailable: string[] }> {
  const sources: SourceRecord[] = [];
  const unavailable: string[] = [];
  for (const id of input.conversation.sourceIds) {
    const source = await input.getSource(id);
    const usable =
      source !== null &&
      !source.tombstonedAt &&
      source.workspaceId === input.conversation.workspaceId &&
      can(input.identity, "source:use", { workspaceId: source.workspaceId });
    if (usable) sources.push(source);
    else unavailable.push(id);
  }
  return { sources, unavailable };
}

/** Refuse a turn or a run in a conversation with nothing left to query. */
export function requireUsable(sources: readonly SourceRecord[]): void {
  if (sources.length === 0) {
    throw new HttpError(
      403,
      "none of this conversation's sources is available to you any more; it is read-only",
    );
  }
}

/** What a conversation's queries run under, on the server. */
export function conversationScope(
  conversation: Pick<Conversation, "variables" | "timeRange">,
  sources: SourceRecord[],
  identity: Identity,
  timeRange: TimeRange = conversation.timeRange,
): ChatScope {
  const variables = conversation.variables ?? {};
  return {
    sources,
    timeRange,
    identity,
    declaredVariables: new Set(Object.keys(variables)),
    variables,
    where: "in this conversation",
  };
}

/**
 * The drawn panel `panelId` in a conversation's stored messages, read back
 * through the IR. Null when no accepted `showPanel` carries that id, or its
 * spec is not one this build would draw.
 */
export function storedPanel(
  messages: readonly UIMessage[],
  panelId: string,
): QueryPanel | null {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== SHOW_PANEL_PART) continue;
      const p = part as { state?: string; input?: unknown; output?: unknown };
      if (p.state !== "output-available" || panelIdOf(p) !== panelId) continue;
      if ((p.output as { ok?: unknown }).ok !== true) continue;
      return chatPanelSpec(p.input, panelId);
    }
  }
  return null;
}

export interface PanelRun {
  columns: string[];
  rows: Record<string, unknown>[];
  /** The window the server resolved for these rows, in epoch ms. */
  window: { from: number; to: number };
}

/**
 * Run a stored panel again: the spec comes from the stored message, never the
 * browser, and is checked against the source's catalog as it is now, under
 * the caller's row scope and the window asked for (an IR expression the
 * server resolves). A refusal or a failed statement is a 400 the page shows.
 */
export async function runStoredPanel(input: {
  panel: QueryPanel;
  scope: ChatScope;
  execute?: ChatExecutor;
  onQuery?: (outcome: "success" | "failure", stage?: string) => void;
}): Promise<PanelRun> {
  const { panel, scope } = input;
  const built = await planChatQuery(scope, panel.query);
  if (!built.ok) {
    input.onQuery?.("failure", "validate");
    throw new HttpError(400, built.error, {}, "statement");
  }
  const execute =
    input.execute ?? ((source, plan) => serverKind(source).execute(source, plan));
  try {
    const result = await execute(built.source, built.plan);
    input.onQuery?.("success");
    const range = resolveTimeRange(scope.timeRange);
    return {
      columns: result.columns,
      rows: result.rows,
      window: { from: range.from.getTime(), to: range.to.getTime() },
    };
  } catch (err) {
    input.onQuery?.("failure", "execute");
    if (err instanceof QueryExecutionError) {
      throw new HttpError(400, err.message, {}, "statement");
    }
    throw err;
  }
}

/**
 * The caller's own conversation `id`, or a 404: someone else's is the same as
 * one that does not exist, and so is one past retention.
 */
export async function ownConversation(
  rawId: string,
  identity: Identity,
  store: Pick<ConversationStore, "get">,
): Promise<Conversation> {
  const id = ConversationId.safeParse(rawId);
  const conversation = id.success
    ? await store.get(id.data, identity.sub, config.chatHistoryRetentionDays)
    : null;
  if (!conversation) throw new HttpError(404, "conversation not found");
  return conversation;
}
