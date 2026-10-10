import { APICallError, createIdGenerator, type UIMessage } from "ai";
import { ModelTimeoutError } from "@/lib/ai/invoke";
import { providerHttpError } from "@/lib/ai/provider-error";
import { buildDataChatPrompt, streamDataChat } from "@/lib/ai/data-chat";
import { recordGeneration } from "@/lib/ai/log";
import { requireModel } from "@/lib/ai/model-resolution";
import { audit } from "@/lib/audit";
import { requireIdentity } from "@/lib/auth/authorize";
import { messagesToPersist } from "@/lib/chat-history";
import {
  conversationRetention,
  conversationScope,
  conversationTitle,
  ownConversation,
  requireUsable,
  TurnBody,
  usableSources,
} from "@/lib/chat/conversations";
import { persistableMessage, readStoredChatMessage } from "@/lib/chat/persist";
import { pgConversationStore } from "@/lib/db/conversations";
import { getSourceById } from "@/lib/db/repo";
import { readJson, route } from "@/lib/http";
import { enforceLlmLimits } from "@/lib/limits/llm";
import { log } from "@/lib/log";
import { recordLlmRepair } from "@/lib/metrics";
import { serverKind } from "@/lib/sources/server/registry";
import { workspacePromptFor } from "@/lib/workspace-prompt-service";

export const runtime = "nodejs";
export const maxDuration = 60;

/** The answer's id, made here: it is the stored row's key. */
const messageId = createIdGenerator({ prefix: "msg", size: 16 });

/**
 * One turn of a conversation (#416). The browser sends only the new question;
 * the history is the stored conversation. Authorization is ownership (the
 * conversation is keyed on the session's subject) and `source:use` on every
 * source, re-checked now: a source the caller lost is left out and the turn
 * runs over the rest, or is refused when none is left.
 *
 * The turn is rate-limited and budgeted per workspace, like every model call;
 * a `showPanel` repair is a second call whose usage is recorded with it. Every
 * statement is audited as the caller's, every drawn spec is a generation, and
 * the finished messages are stored with each panel's rows stripped.
 */
export const POST = route(
  "chat.turn",
  async (req: Request, ctx: RouteContext<"/api/chat/[id]/messages">) => {
    const identity = await requireIdentity();
    const conversation = await ownConversation(
      (await ctx.params).id,
      identity,
      pgConversationStore,
    );
    const { sources } = await usableSources({
      identity,
      conversation,
      getSource: getSourceById,
    });
    requireUsable(sources);
    const { workspaceId } = conversation;
    const body = await readJson(req, TurnBody);

    const resolved = await requireModel({ identity, workspaceId });
    const usage = await enforceLlmLimits({
      identity,
      workspaceId,
      route: "chat",
      model: resolved.modelId,
    });

    const retention = conversationRetention();
    const stored = await pgConversationStore.messages(
      conversation.id,
      identity.sub,
      retention,
    );
    const history = stored.map(readStoredChatMessage).filter((m) => m !== null);
    const storedIds = history.map((m) => m.id);
    const question = body.message as UIMessage;
    const messages = [...history.filter((m) => m.id !== question.id), question];

    // The workspace's own context (#66). Advisory: unreadable, the turn runs
    // on the base prompt rather than failing.
    const workspacePrompt = await workspacePromptFor(sources).catch((error: unknown) => {
      log.warn("workspace_prompt.load_failed", { workspaceId, error });
      return null;
    });
    const catalog = sources.map((s) => serverKind(s).catalogPrompt(s)).join("\n\n");
    const promptText = conversationTitle(question) ?? "";

    audit({
      actor: identity,
      action: "chat.turn",
      workspaceId,
      resource: { type: "conversation", id: conversation.id },
      detail: {
        messageCount: messages.length,
        modelConfig: resolved.source,
        timeRange: conversation.timeRange,
        sourceIds: sources.map((s) => s.id),
      },
    });

    const result = await streamDataChat({
      system: buildDataChatPrompt({
        sources,
        timeRange: conversation.timeRange,
        workspacePrompt,
      }),
      scope: conversationScope(conversation, sources, identity),
      model: resolved.model,
      messages,
      abortSignal: req.signal,
      onUsage: usage.record,
      onRepair: ({ usage: used, repaired }) => {
        usage.record(used);
        recordLlmRepair("chat", repaired ? "repaired" : "failed");
      },
      // Each statement is the caller's execution, on their authority (#30).
      onQuery: (q) =>
        audit({
          actor: identity,
          action: "query.execute",
          workspaceId,
          resource: { type: "source", id: q.sourceId },
          outcome: q.outcome,
          detail: {
            via: "chat",
            conversationId: conversation.id,
            ...(q.panelId ? { panelId: q.panelId } : {}),
            ...(q.promql !== undefined ? { promql: q.promql } : { sql: q.sql }),
            stage: q.stage,
          },
        }),
      // Every drawn spec, accepted or refused, is a generation a source-admin
      // can read back, as for a dashboard generation.
      onPanel: (p) =>
        recordGeneration({
          workspaceId,
          createdBy: identity.sub,
          mode: "chat",
          sourceId: p.sourceId,
          prompt: promptText,
          catalog,
          spec: p.outcome === "accepted" ? p.spec : null,
          model: resolved.modelId,
          modelConfig: resolved.source,
          error: p.error,
        }),
    });

    return result.toUIMessageStreamResponse({
      originalMessages: messages,
      generateMessageId: messageId,
      // A provider failure names the setting to fix (#337); anything else
      // keeps the SDK default's reticence.
      onError: (error) =>
        APICallError.isInstance(error) || error instanceof ModelTimeoutError
          ? providerHttpError(error).message
          : "Something went wrong while answering. Try again.",
      onEnd: async ({ messages: finished }) => {
        try {
          await pgConversationStore.append({
            conversationId: conversation.id,
            userSub: identity.sub,
            messages: messagesToPersist(finished, storedIds)
              .map(persistableMessage)
              .map((m) => ({ id: m.id, role: m.role, content: m })),
            title: conversationTitle(question),
            retention,
          });
        } catch (err) {
          // The answer already reached the browser; failing to keep it is a
          // log line, not a broken response.
          log.error("chat.persist_failed", { conversationId: conversation.id, err });
        }
      },
    });
  },
);
