import { z } from "zod";
import type { UIMessage } from "ai";
import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { json, readJson, route } from "@/lib/http";
import {
  appendChatMessages,
  clearChatMessages,
  getDashboardById,
  getSourceById,
  listChatMessages,
} from "@/lib/db/repo";
import { resolveChatSources, streamDashboardChat } from "@/lib/ai/chat";
import { enforceLlmLimits } from "@/lib/limits/llm";
import { messagesToPersist, parseStoredMessages } from "@/lib/chat-history";
import { config } from "@/lib/config";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 60;

// UIMessage has a rich, evolving shape owned by the AI SDK; we validate the
// envelope (a bounded, non-empty array) and let convertToModelMessages enforce
// the rest. The SQL/query surface is guarded server-side regardless of input.
const Body = z.object({
  messages: z.array(z.unknown()).min(1).max(100),
});

type RouteParams = { params: Promise<{ id: string }> };

const retention = () => ({
  limit: config.chatHistoryMaxMessages,
  retentionDays: config.chatHistoryRetentionDays,
});

/**
 * The dashboard a caller may chat with, or a throw.
 *
 * All three methods need the same two checks in the same order, and the answer
 * — `dashboard:view` on the dashboard's own workspace — is the whole
 * authorization story for chat. A conversation is scoped to the caller's own
 * subject, so there is no separate "may I read this history" question: the
 * subject is taken from the session and never from the request.
 */
async function authorizedDashboard(ctx: RouteParams) {
  const identity = await requireIdentity();
  const { id } = await ctx.params;
  const dashboard = await getDashboardById(id);
  if (!dashboard) throw new HttpError(404, "dashboard not found");
  assertAuthorized(identity, "dashboard:view", {
    workspaceId: dashboard.workspaceId,
  });
  return { identity, id, dashboard };
}

/**
 * This caller's conversation on this dashboard, oldest first.
 *
 * Rows are shape-checked on the way out rather than cast: `content` is opaque
 * JSONB holding an SDK shape that evolves, and a message that no longer parses
 * is dropped so the conversation starts a turn shorter instead of replaying
 * something half-understood.
 */
export const GET = route(
  "dashboards.chat.history",
  async (_req: Request, ctx: RouteParams) => {
    const { identity, id } = await authorizedDashboard(ctx);
    const rows = await listChatMessages(id, identity.sub, retention());
    return json({ messages: parseStoredMessages(rows) });
  },
);

/** Forget this caller's conversation on this dashboard. Nobody else's. */
export const DELETE = route(
  "dashboards.chat.clear",
  async (_req: Request, ctx: RouteParams) => {
    const { identity, id } = await authorizedDashboard(ctx);
    const deleted = await clearChatMessages(id, identity.sub);
    return json({ deleted });
  },
);

/**
 * Read-only chat scoped to a single dashboard. Authorization: viewer on the
 * dashboard's workspace. The model may fetch fresh data only from the sources
 * this dashboard already references AND that the caller may use — each is
 * re-resolved and re-authorized in `resolveChatSources`; unavailable ones are
 * silently omitted (never surfaced), mirroring the poller's tombstone handling.
 * A turn may take several model round trips; the rate limit counts the turn
 * once and the budget records the usage summed over every step.
 *
 * The turn is persisted per caller per dashboard (#82). `abortSignal` is the
 * request's own, so a browser that stops a generation actually cancels the
 * model call rather than leaving it running with nobody listening; `onEnd`
 * still fires on that path, carrying `isAborted`, so the partial answer is
 * stored rather than lost.
 */
export const POST = route("dashboards.chat", async (req: Request, ctx: RouteParams) => {
  const { identity, id, dashboard } = await authorizedDashboard(ctx);
  const body = await readJson(req, Body);

  const usage = await enforceLlmLimits({
    identity,
    workspaceId: dashboard.workspaceId,
    route: "chat",
  });

  const sources = await resolveChatSources({
    identity,
    dashboard: dashboard.spec,
    getSource: getSourceById,
  });

  const incoming = body.messages as UIMessage[];
  // What is already on disk, so `onEnd` — which hands back the whole
  // conversation — only writes the tail this turn produced.
  const stored = await listChatMessages(id, identity.sub, retention());
  const storedIds = stored.map((m) => m.id);

  const result = await streamDashboardChat({
    dashboard: dashboard.spec,
    sources,
    messages: incoming,
    onUsage: usage.record,
    abortSignal: req.signal,
  });

  return result.toUIMessageStreamResponse({
    originalMessages: incoming,
    onEnd: async ({ messages }) => {
      try {
        await appendChatMessages({
          dashboardId: id,
          userSub: identity.sub,
          messages: messagesToPersist(messages, storedIds).map((m) => ({
            id: m.id,
            role: m.role,
            content: m,
          })),
          ...retention(),
        });
      } catch (err) {
        // The answer already reached the browser. Failing to remember it is
        // worth a log line, not a broken response the reader cannot retry.
        log.error("chat.persist_failed", { dashboardId: id, err });
      }
    },
  });
});
