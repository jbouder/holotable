import { z } from "zod";
import { ModelTimeoutError } from "@/lib/ai/invoke";
import { providerHttpError } from "@/lib/ai/provider-error";
import { APICallError, type UIMessage } from "ai";
import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import type { Identity } from "@/lib/auth/claims";
import { json, readJson, route } from "@/lib/http";
import { audit } from "@/lib/audit";
import { getDashboardById, getSourceById } from "@/lib/db/repo";
import { pgConversationStore } from "@/lib/db/conversations";
import { persistableMessage, readStoredChatMessage } from "@/lib/chat/persist";
import { conversationTitle } from "@/lib/chat/conversations";
import { requestPreferences } from "@/lib/preferences-server";
import { workspacePromptFor } from "@/lib/workspace-prompt-service";
import { randomUUID } from "node:crypto";
import { resolveChatSources, resolveChatView, streamDashboardChat } from "@/lib/ai/chat";
import {
  Panel,
  TimeRange,
  VARIABLE_VALUES_MAX,
  VariableName,
  VariableText,
} from "@/lib/ir";
import { resolveTimeRange } from "@/lib/time";
import { rowScopeFor } from "@/lib/row-scope";
import { checkedSelection, variableSourceIds } from "@/lib/variables";
import { requireModel } from "@/lib/ai/model-resolution";
import { enforceLlmLimits } from "@/lib/limits/llm";
import { messagesToPersist } from "@/lib/chat-history";
import { config } from "@/lib/config";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 60;

// UIMessage has a rich, evolving shape owned by the AI SDK; we validate the
// envelope (a bounded, non-empty array) and let convertToModelMessages enforce
// the rest. The SQL/query surface is guarded server-side regardless of input.
//
// The rest is what the reader has on screen (#366), every field a request the
// server checks rather than a fact: the range is an IR time expression it
// resolves itself, the picks go through the stream's allowlist, and the panel
// is an id looked up in the stored spec. None of them carries SQL.
const Body = z.object({
  messages: z.array(z.unknown()).min(1).max(100),
  timeRange: TimeRange.optional(),
  variables: z
    .record(VariableName, z.array(VariableText).max(VARIABLE_VALUES_MAX))
    .refine((v) => Object.keys(v).length <= 20, "at most 20 variables")
    .optional(),
  panelId: Panel.shape.id.optional(),
});

type RouteParams = { params: Promise<{ id: string }> };

const retention = () => ({
  limit: config.chatHistoryMaxMessages,
  retentionDays: config.chatHistoryRetentionDays,
});

/**
 * This caller's conversation on this dashboard (#416, phase 6): the Chat
 * conversation with this `dashboard_id` and this subject, or none. Someone
 * who keeps no conversations has none, and the chat behaves as it did before
 * history was kept.
 */
async function storedConversation(identity: Identity, dashboardId: string) {
  if (!(await requestPreferences(identity)).rememberChats) return null;
  return pgConversationStore.findForDashboard(
    identity.sub,
    dashboardId,
    config.chatHistoryRetentionDays,
  );
}

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
  assertAuthorized(
    identity,
    "dashboard:view",
    { workspaceId: dashboard.workspaceId },
    { type: "dashboard", id },
  );
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
    const conversation = await storedConversation(identity, id);
    if (!conversation) return json({ messages: [], conversationId: null });
    const rows = await pgConversationStore.messages(
      conversation.id,
      identity.sub,
      retention(),
    );
    return json({
      messages: rows.map(readStoredChatMessage).filter((m) => m !== null),
      // So the widget can open the same conversation in Chat.
      conversationId: conversation.id,
    });
  },
);

/** Forget this caller's conversation on this dashboard. Nobody else's. */
export const DELETE = route(
  "dashboards.chat.clear",
  async (_req: Request, ctx: RouteParams) => {
    const { identity, id } = await authorizedDashboard(ctx);
    const conversation = await pgConversationStore.findForDashboard(identity.sub, id, 0);
    if (!conversation) return json({ deleted: 0 });
    const rows = await pgConversationStore.messages(conversation.id, identity.sub, {
      limit: config.chatHistoryMaxMessages,
      retentionDays: 0,
    });
    await pgConversationStore.remove(conversation.id, identity.sub);
    return json({ deleted: rows.length });
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

  const resolved = await requireModel({ identity, workspaceId: dashboard.workspaceId });

  const usage = await enforceLlmLimits({
    identity,
    workspaceId: dashboard.workspaceId,
    route: "chat",
    model: resolved.modelId,
  });

  if (body.timeRange) {
    try {
      resolveTimeRange(body.timeRange);
    } catch {
      throw new HttpError(400, "invalid time range", {}, "validation");
    }
  }

  const sources = await resolveChatSources({
    identity,
    dashboard: dashboard.spec,
    getSource: getSourceById,
  });

  // The picks are checked exactly as the stream checks them: against what
  // each variable offers this reader, under their row scope.
  const variableSources = (
    await Promise.all(variableSourceIds(dashboard.spec.variables).map(getSourceById))
  ).filter(
    (s): s is NonNullable<typeof s> =>
      s !== null && !s.tombstonedAt && s.workspaceId === dashboard.workspaceId,
  );
  const scope = rowScopeFor(identity, [...sources, ...variableSources]);
  const { dashboard: viewed, view } = await resolveChatView({
    dashboard: dashboard.spec,
    timeRange: body.timeRange,
    picks: body.variables ?? {},
    panelId: body.panelId,
    check: (picks) =>
      checkedSelection(dashboard.spec.variables, picks, dashboard.workspaceId, scope),
  });

  const incoming = body.messages as UIMessage[];
  // What is already on disk, so `onEnd` — which hands back the whole
  // conversation — only writes the tail this turn produced.
  const kept = await storedConversation(identity, id);
  const stored = kept
    ? await pgConversationStore.messages(kept.id, identity.sub, retention())
    : [];
  const storedIds = stored.map((m) => m.id);
  const keep = (await requestPreferences(identity)).rememberChats;
  // The workspace's own context (#66), as every other prompt has it.
  // Advisory: unreadable, the turn runs on the base prompt.
  const workspacePrompt = await workspacePromptFor(sources).catch((error: unknown) => {
    log.warn("workspace_prompt.load_failed", {
      workspaceId: dashboard.workspaceId,
      error,
    });
    return null;
  });

  audit({
    actor: identity,
    action: "dashboard.chat",
    workspaceId: dashboard.workspaceId,
    resource: { type: "dashboard", id },
    detail: {
      messageCount: incoming.length,
      modelConfig: resolved.source,
      timeRange: viewed.timeRange,
      variables: view.variables,
      panelId: view.focusPanelId,
    },
  });

  const result = await streamDashboardChat({
    dashboard: viewed,
    sources,
    identity,
    view,
    workspacePrompt,
    model: resolved.model,
    messages: incoming,
    onUsage: usage.record,
    // Each statement the model runs is the reader's execution, on their
    // authority, so it is audited as theirs (#30).
    onQuery: (q) =>
      audit({
        actor: identity,
        action: "query.execute",
        workspaceId: dashboard.workspaceId,
        resource: { type: "source", id: q.sourceId },
        outcome: q.outcome,
        detail: {
          via: "chat",
          dashboardId: id,
          ...(q.promql !== undefined ? { promql: q.promql } : { sql: q.sql }),
          stage: q.stage,
        },
      }),
    abortSignal: req.signal,
  });

  return result.toUIMessageStreamResponse({
    originalMessages: incoming,
    // The SDK's default says only "An error occurred." A provider failure
    // names the setting to fix instead (#337); anything else keeps the
    // default's reticence, since its message could be anything.
    onError: (error) =>
      APICallError.isInstance(error) || error instanceof ModelTimeoutError
        ? providerHttpError(error).message
        : "Something went wrong while answering. Try again.",
    onEnd: async ({ messages }) => {
      if (!keep) return;
      try {
        const conversation =
          kept ??
          (await pgConversationStore.forDashboard({
            id: randomUUID(),
            userSub: identity.sub,
            workspaceId: dashboard.workspaceId,
            dashboardId: id,
            timeRange: viewed.timeRange,
            variables: view.variables,
            max: config.chatConversationsMax,
            retentionDays: config.chatHistoryRetentionDays,
          }));
        const question = incoming.findLast((m) => m.role === "user");
        await pgConversationStore.append({
          conversationId: conversation.id,
          userSub: identity.sub,
          messages: messagesToPersist(messages, storedIds)
            .map(persistableMessage)
            .map((m) => ({ id: m.id, role: m.role, content: m })),
          title: question ? conversationTitle(question) : undefined,
          retention: retention(),
        });
      } catch (err) {
        // The answer already reached the browser. Failing to remember it is
        // worth a log line, not a broken response the reader cannot retry.
        log.error("chat.persist_failed", { dashboardId: id, err });
      }
    },
  });
});
