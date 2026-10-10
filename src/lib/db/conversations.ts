import type { PoolClient } from "pg";
import { query, withTransaction } from "@/lib/db/pg";
import type { StoredChatMessage } from "@/lib/chat-history";
import { TimeRange } from "@/lib/ir";
import { VariableValuesBody } from "@/lib/variable-selection";
import type { VariableValues } from "@/lib/sql/variables";

/**
 * Chat conversations and their messages (#416).
 *
 * Every statement filters on `user_sub`, which the caller takes from the
 * session and never from a request: a conversation id of someone else's is
 * the same as one that does not exist. Retention is applied on the way out
 * as well as swept on the way in, so shortening it takes effect at once.
 */

export interface Conversation {
  id: string;
  workspaceId: string;
  sourceIds: string[];
  dashboardId: string | null;
  /** Empty until the first question names it. */
  title: string;
  timeRange: TimeRange;
  variables: VariableValues | null;
  createdAt: string;
  updatedAt: string;
}

export type ConversationSummary = Pick<
  Conversation,
  "id" | "title" | "sourceIds" | "dashboardId" | "workspaceId" | "updatedAt"
>;

/** Where a page of the history list resumes: after this row. */
export interface ConversationCursor {
  updatedAt: string;
  id: string;
}

/** The bounds every read and write applies. */
export interface ConversationRetention {
  /** Messages kept per conversation. */
  limit: number;
  /** Days a message, and a conversation with none newer, is kept; 0: forever. */
  retentionDays: number;
}

export interface ConversationStore {
  create(input: {
    id: string;
    userSub: string;
    workspaceId: string;
    sourceIds: string[];
    timeRange: TimeRange;
    dashboardId?: string | null;
    variables?: VariableValues | null;
    /** Conversations one person keeps; the least recently used go first. */
    max: number;
    retentionDays: number;
  }): Promise<Conversation>;
  get(id: string, userSub: string, retentionDays: number): Promise<Conversation | null>;
  /**
   * This person's conversation on a dashboard (#416, phase 6), made on first
   * use: at most one per person per dashboard. Its sources are the
   * dashboard's, so it stores none.
   */
  forDashboard(input: {
    id: string;
    userSub: string;
    workspaceId: string;
    dashboardId: string;
    timeRange: TimeRange;
    variables?: VariableValues | null;
    max: number;
    retentionDays: number;
  }): Promise<Conversation>;
  /** This person's conversation on a dashboard, if they have one. */
  findForDashboard(
    userSub: string,
    dashboardId: string,
    retentionDays: number,
  ): Promise<Conversation | null>;
  list(input: {
    userSub: string;
    limit: number;
    retentionDays: number;
    after?: ConversationCursor;
  }): Promise<ConversationSummary[]>;
  update(
    id: string,
    userSub: string,
    patch: {
      title?: string;
      workspaceId?: string;
      sourceIds?: string[];
      timeRange?: TimeRange;
    },
  ): Promise<Conversation | null>;
  /** Whether a conversation of this person's was deleted. */
  remove(id: string, userSub: string): Promise<boolean>;
  /** How many of this person's conversations were deleted. */
  removeAll(userSub: string): Promise<number>;
  messages(
    conversationId: string,
    userSub: string,
    retention: ConversationRetention,
  ): Promise<StoredChatMessage[]>;
  /**
   * Append or update messages, sweep what fell out of retention, mark the
   * conversation used, and name it from `title` when it has no name yet.
   */
  append(input: {
    conversationId: string;
    userSub: string;
    messages: { id: string; role: string; content: unknown }[];
    title?: string;
    retention: ConversationRetention;
  }): Promise<void>;
}

interface Row extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  source_ids: string[];
  dashboard_id: string | null;
  title: string;
  time_range: unknown;
  variables: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

const COLUMNS =
  "id, workspace_id, source_ids, dashboard_id, title, time_range, variables, created_at, updated_at";

const iso = (v: Date | string) => new Date(v).toISOString();

/**
 * A stored row as a conversation. The range and the picks are read back
 * through their schemas, as anything stored is: a row that no longer parses
 * falls back to the last hour and no picks rather than failing the page.
 */
function toConversation(row: Row): Conversation {
  const range = TimeRange.safeParse(row.time_range);
  const variables = VariableValuesBody.safeParse(row.variables);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceIds: row.source_ids ?? [],
    dashboardId: row.dashboard_id,
    title: row.title,
    timeRange: range.success ? range.data : { from: "now-1h", to: "now" },
    variables: row.variables != null && variables.success ? variables.data : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** A conversation is gone once nothing in it is newer than the retention window. */
const LIVE = "($R <= 0 OR updated_at > now() - make_interval(days => $R))";
const live = (param: number) => LIVE.replaceAll("$R", `$${param}`);

type Run = <T extends Record<string, unknown>>(
  text: string,
  params: unknown[],
) => Promise<T[]>;

function onClient(client: PoolClient): Run {
  return async <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    (await client.query(text, params as never[])).rows as T[];
}

export function makeConversationStore(deps: {
  run: Run;
  transaction: <T>(fn: (run: Run) => Promise<T>) => Promise<T>;
}): ConversationStore {
  const { run, transaction } = deps;
  return {
    async create(input) {
      return transaction(async (tx) => {
        const [row] = await tx<Row>(
          `INSERT INTO conversations
             (id, user_sub, workspace_id, source_ids, dashboard_id, time_range, variables)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
           RETURNING ${COLUMNS}`,
          [
            input.id,
            input.userSub,
            input.workspaceId,
            input.sourceIds,
            input.dashboardId ?? null,
            JSON.stringify(input.timeRange),
            input.variables ? JSON.stringify(input.variables) : null,
          ],
        );
        // The sweep runs where rows are added, so the table is bounded
        // without a scheduled job: expired conversations, then the least
        // recently used past the cap.
        await tx(
          `DELETE FROM conversations
           WHERE user_sub = $1 AND NOT ${live(2)}`,
          [input.userSub, input.retentionDays],
        );
        await tx(
          `DELETE FROM conversations
           WHERE user_sub = $1 AND id NOT IN (
             SELECT id FROM conversations WHERE user_sub = $1
             ORDER BY updated_at DESC, id DESC
             LIMIT $2
           )`,
          [input.userSub, input.max],
        );
        return toConversation(row);
      });
    },

    async forDashboard(input) {
      const found = await this.findForDashboard(
        input.userSub,
        input.dashboardId,
        input.retentionDays,
      );
      if (found) return found;
      // Past retention the old row still holds the slot; it goes first.
      await run(
        `DELETE FROM conversations
         WHERE user_sub = $1 AND dashboard_id = $2 AND NOT ${live(3)}`,
        [input.userSub, input.dashboardId, input.retentionDays],
      );
      return transaction(async (tx) => {
        const [row] = await tx<Row>(
          `INSERT INTO conversations
             (id, user_sub, workspace_id, source_ids, dashboard_id, time_range, variables)
           VALUES ($1, $2, $3, '{}', $4, $5::jsonb, $6::jsonb)
           ON CONFLICT (user_sub, dashboard_id) WHERE dashboard_id IS NOT NULL
           DO UPDATE SET updated_at = conversations.updated_at
           RETURNING ${COLUMNS}`,
          [
            input.id,
            input.userSub,
            input.workspaceId,
            input.dashboardId,
            JSON.stringify(input.timeRange),
            input.variables ? JSON.stringify(input.variables) : null,
          ],
        );
        await tx(
          `DELETE FROM conversations
           WHERE user_sub = $1 AND id NOT IN (
             SELECT id FROM conversations WHERE user_sub = $1
             ORDER BY updated_at DESC, id DESC
             LIMIT $2
           )`,
          [input.userSub, input.max],
        );
        return toConversation(row);
      });
    },

    async findForDashboard(userSub, dashboardId, retentionDays) {
      const [row] = await run<Row>(
        `SELECT ${COLUMNS} FROM conversations
         WHERE user_sub = $1 AND dashboard_id = $2 AND ${live(3)}`,
        [userSub, dashboardId, retentionDays],
      );
      return row ? toConversation(row) : null;
    },

    async get(id, userSub, retentionDays) {
      const [row] = await run<Row>(
        `SELECT ${COLUMNS} FROM conversations
         WHERE id = $1 AND user_sub = $2 AND ${live(3)}`,
        [id, userSub, retentionDays],
      );
      return row ? toConversation(row) : null;
    },

    async list({ userSub, limit, retentionDays, after }) {
      const rows = await run<Row>(
        `SELECT ${COLUMNS} FROM conversations
         WHERE user_sub = $1 AND ${live(2)}
           AND ($3::timestamptz IS NULL OR (updated_at, id) < ($3::timestamptz, $4::uuid))
         ORDER BY updated_at DESC, id DESC
         LIMIT $5`,
        [userSub, retentionDays, after?.updatedAt ?? null, after?.id ?? null, limit],
      );
      return rows.map((row) => {
        const c = toConversation(row);
        return {
          id: c.id,
          title: c.title,
          sourceIds: c.sourceIds,
          dashboardId: c.dashboardId,
          workspaceId: c.workspaceId,
          updatedAt: c.updatedAt,
        };
      });
    },

    async update(id, userSub, patch) {
      const [row] = await run<Row>(
        `UPDATE conversations SET
           title = coalesce($3, title),
           workspace_id = coalesce($4, workspace_id),
           source_ids = coalesce($5, source_ids),
           time_range = coalesce($6::jsonb, time_range),
           updated_at = now()
         WHERE id = $1 AND user_sub = $2
         RETURNING ${COLUMNS}`,
        [
          id,
          userSub,
          patch.title ?? null,
          patch.workspaceId ?? null,
          patch.sourceIds ?? null,
          patch.timeRange ? JSON.stringify(patch.timeRange) : null,
        ],
      );
      return row ? toConversation(row) : null;
    },

    async remove(id, userSub) {
      const rows = await run<{ id: string }>(
        "DELETE FROM conversations WHERE id = $1 AND user_sub = $2 RETURNING id",
        [id, userSub],
      );
      return rows.length > 0;
    },

    async removeAll(userSub) {
      const rows = await run<{ id: string }>(
        "DELETE FROM conversations WHERE user_sub = $1 RETURNING id",
        [userSub],
      );
      return rows.length;
    },

    async messages(conversationId, userSub, { limit, retentionDays }) {
      // `LIMIT` takes the newest messages and the outer select puts them back
      // in order: the tail of a conversation is the part with context. The
      // join is the ownership check.
      const rows = await run<{
        id: string;
        role: string;
        content: unknown;
        created_at: Date | string;
      }>(
        `SELECT id, role, content, created_at FROM (
           SELECT m.id, m.role, m.content, m.created_at, m.seq
           FROM conversation_messages m
           JOIN conversations c ON c.id = m.conversation_id
           WHERE m.conversation_id = $1 AND c.user_sub = $2
             AND ($4 <= 0 OR m.created_at > now() - make_interval(days => $4))
           ORDER BY m.seq DESC
           LIMIT $3
         ) recent
         ORDER BY seq ASC`,
        [conversationId, userSub, limit, retentionDays],
      );
      return rows.map((row) => ({
        id: row.id,
        role: row.role as StoredChatMessage["role"],
        content: row.content,
        createdAt: iso(row.created_at),
      }));
    },

    async append({ conversationId, userSub, messages, title, retention }) {
      await transaction(async (tx) => {
        const owned = await tx<{ id: string }>(
          `UPDATE conversations
           SET updated_at = now(),
               title = CASE WHEN title = '' AND $3::text IS NOT NULL THEN $3 ELSE title END
           WHERE id = $1 AND user_sub = $2
           RETURNING id`,
          [conversationId, userSub, title ?? null],
        );
        if (owned.length === 0) return;
        for (const message of messages) {
          // A re-sent id means "this message grew", not a second message.
          await tx(
            `INSERT INTO conversation_messages (conversation_id, id, role, content)
             VALUES ($1, $2, $3, $4::jsonb)
             ON CONFLICT (conversation_id, id) DO UPDATE SET content = EXCLUDED.content`,
            [conversationId, message.id, message.role, JSON.stringify(message.content)],
          );
        }
        await tx(
          `DELETE FROM conversation_messages
           WHERE conversation_id = $1
             AND (
               ($3 > 0 AND created_at <= now() - make_interval(days => $3))
               OR id NOT IN (
                 SELECT id FROM conversation_messages
                 WHERE conversation_id = $1
                 ORDER BY seq DESC
                 LIMIT $2
               )
             )`,
          [conversationId, retention.limit, retention.retentionDays],
        );
      });
    },
  };
}

export const pgConversationStore: ConversationStore = makeConversationStore({
  run: query,
  transaction: (fn) => withTransaction((client) => fn(onClient(client))),
});
