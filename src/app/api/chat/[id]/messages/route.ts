import type { UIMessage } from "ai";
import { requireIdentity } from "@/lib/auth/authorize";
import { messagesToPersist } from "@/lib/chat-history";
import {
  conversationRetention,
  conversationTitle,
  ownConversation,
  requireUsable,
  TurnBody,
  usableSources,
} from "@/lib/chat/conversations";
import { persistableMessage, readStoredChatMessage } from "@/lib/chat/persist";
import { chatTurnResponse } from "@/lib/chat/turn";
import { pgConversationStore } from "@/lib/db/conversations";
import { getSourceById } from "@/lib/db/repo";
import { readJson, route } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * One turn of a kept conversation (#416). The browser sends only the new
 * question; the history is the stored conversation. Authorization is
 * ownership (the conversation is keyed on the session's subject) and
 * `source:use` on every source, re-checked now: a source the caller lost is
 * left out and the turn runs over the rest, or is refused when none is left.
 * The finished messages are stored with each panel's rows stripped.
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
    const body = await readJson(req, TurnBody);

    const retention = conversationRetention();
    const stored = await pgConversationStore.messages(
      conversation.id,
      identity.sub,
      retention,
    );
    const history = stored.map(readStoredChatMessage).filter((m) => m !== null);
    const storedIds = history.map((m) => m.id);
    const question = body.message as UIMessage;

    return chatTurnResponse({
      identity,
      workspaceId: conversation.workspaceId,
      sources,
      timeRange: conversation.timeRange,
      variables: conversation.variables,
      messages: [...history.filter((m) => m.id !== question.id), question],
      conversationId: conversation.id,
      abortSignal: req.signal,
      onEnd: (finished) =>
        pgConversationStore.append({
          conversationId: conversation.id,
          userSub: identity.sub,
          messages: messagesToPersist(finished, storedIds)
            .map(persistableMessage)
            .map((m) => ({ id: m.id, role: m.role, content: m })),
          title: conversationTitle(question),
          retention,
        }),
    });
  },
);
