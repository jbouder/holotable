import { z } from "zod";
import { audit } from "@/lib/audit";
import { HttpError, requireIdentity } from "@/lib/auth/authorize";
import {
  conversationRetention,
  ownConversation,
  requestedSources,
  SourceIds,
  Title,
  conversationContext,
} from "@/lib/chat/conversations";
import { readStoredChatMessage } from "@/lib/chat/persist";
import { pgConversationStore } from "@/lib/db/conversations";
import { getDashboardById, getSourceById } from "@/lib/db/repo";
import { TimeRange } from "@/lib/ir";
import { json, readJson, route } from "@/lib/http";
import { resolveTimeRange } from "@/lib/time";

export const runtime = "nodejs";

const PatchBody = z
  .object({
    title: Title.optional(),
    sourceIds: SourceIds.optional(),
    timeRange: TimeRange.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, "nothing to change");

type Ctx = RouteContext<"/api/chat/[id]">;

/**
 * One of this person's conversations and its messages. A drawn panel's rows
 * are not stored, so the page runs each panel again through the run route;
 * the sources the caller can no longer use are named, and with none left the
 * conversation is shown read-only.
 */
export const GET = route("chat.get", async (_req: Request, ctx: Ctx) => {
  const identity = await requireIdentity();
  const conversation = await ownConversation(
    (await ctx.params).id,
    identity,
    pgConversationStore,
  );
  const [stored, { sources, unavailable, dashboard }] = await Promise.all([
    pgConversationStore.messages(conversation.id, identity.sub, conversationRetention()),
    conversationContext({
      identity,
      conversation,
      getSource: getSourceById,
      getDashboard: getDashboardById,
    }),
  ]);
  return json({
    conversation,
    // Names only: what the chip shows, never a connection detail.
    sources: sources.map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
    unavailableSourceIds: unavailable,
    // The dashboard whose chat this continues, by id and title only.
    dashboard: dashboard ? { id: dashboard.id, title: dashboard.title } : null,
    messages: stored.map(readStoredChatMessage).filter((m) => m !== null),
  });
});

/**
 * Rename a conversation, or change its sources (re-authorized, and in the
 * same workspace) or its range (an IR expression the server resolves).
 */
export const PATCH = route("chat.update", async (req: Request, ctx: Ctx) => {
  const identity = await requireIdentity();
  const conversation = await ownConversation(
    (await ctx.params).id,
    identity,
    pgConversationStore,
  );
  const body = await readJson(req, PatchBody);
  if (body.timeRange) {
    try {
      resolveTimeRange(body.timeRange);
    } catch {
      throw new HttpError(400, "invalid time range", {}, "validation");
    }
  }
  // A dashboard's conversation queries the dashboard's sources (#416).
  if (body.sourceIds && conversation.dashboardId) {
    throw new HttpError(
      400,
      "this conversation uses its dashboard's sources; start a new conversation for others",
      {},
      "validation",
    );
  }
  const sourceIds = body.sourceIds
    ? (
        await requestedSources({
          identity,
          sourceIds: body.sourceIds,
          getSource: getSourceById,
          workspaceId: conversation.workspaceId,
        })
      ).sources.map((s) => s.id)
    : undefined;
  const updated = await pgConversationStore.update(conversation.id, identity.sub, {
    title: body.title,
    sourceIds,
    timeRange: body.timeRange,
  });
  if (!updated) throw new HttpError(404, "conversation not found");
  audit({
    actor: identity,
    action: "chat.update",
    workspaceId: conversation.workspaceId,
    resource: { type: "conversation", id: conversation.id },
    // What changed, not the title's text: it is the person's own words.
    detail: {
      renamed: body.title !== undefined,
      ...(sourceIds ? { sourceIds } : {}),
      ...(body.timeRange ? { timeRange: body.timeRange } : {}),
    },
  });
  return json({ conversation: updated });
});

/** Delete one conversation and its messages, at once. */
export const DELETE = route("chat.delete", async (_req: Request, ctx: Ctx) => {
  const identity = await requireIdentity();
  const conversation = await ownConversation(
    (await ctx.params).id,
    identity,
    pgConversationStore,
  );
  const deleted = await pgConversationStore.remove(conversation.id, identity.sub);
  if (!deleted) throw new HttpError(404, "conversation not found");
  audit({
    actor: identity,
    action: "chat.delete",
    workspaceId: conversation.workspaceId,
    resource: { type: "conversation", id: conversation.id },
    detail: { deleted: 1 },
  });
  return json({ deleted: 1 });
});
