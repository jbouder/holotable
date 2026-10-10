import { randomUUID } from "node:crypto";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { HttpError, requireIdentity } from "@/lib/auth/authorize";
import {
  CONVERSATIONS_PAGE,
  ConversationId,
  requestedSources,
  SourceIds,
} from "@/lib/chat/conversations";
import { config } from "@/lib/config";
import { pgConversationStore } from "@/lib/db/conversations";
import { getSourceById } from "@/lib/db/repo";
import { TimeRange } from "@/lib/ir";
import { json, readJson, route } from "@/lib/http";
import { resolveTimeRange } from "@/lib/time";

export const runtime = "nodejs";

const CreateBody = z
  .object({
    sourceIds: SourceIds,
    timeRange: TimeRange.default({ from: "now-1h", to: "now" }),
  })
  .strict();

/** The `after` cursor of the history list: the last row's `updatedAt` and id. */
const Cursor = z.object({ updatedAt: z.iso.datetime(), id: ConversationId });

/**
 * This person's conversations (#416), most recently used first, paged.
 * Signed in is enough: the list is keyed on the session's subject, and
 * there is nothing in it but their own.
 */
export const GET = route("chat.list", async (req: Request) => {
  const identity = await requireIdentity();
  const url = new URL(req.url);
  const rawAfter = url.searchParams.get("after");
  let after: z.infer<typeof Cursor> | undefined;
  if (rawAfter) {
    const [updatedAt, id] = rawAfter.split("~");
    const parsed = Cursor.safeParse({ updatedAt, id });
    if (!parsed.success) throw new HttpError(400, "invalid cursor", {}, "validation");
    after = parsed.data;
  }
  const conversations = await pgConversationStore.list({
    userSub: identity.sub,
    limit: CONVERSATIONS_PAGE,
    retentionDays: config.chatHistoryRetentionDays,
    after,
  });
  const last = conversations.at(-1);
  return json({
    conversations,
    next:
      conversations.length === CONVERSATIONS_PAGE && last
        ? `${last.updatedAt}~${last.id}`
        : null,
  });
});

/**
 * Start a conversation over some sources. Each must be one the caller may use
 * (`source:use`), all in one workspace, which is the conversation's; the
 * range is an IR expression the server resolves on every run.
 */
export const POST = route("chat.create", async (req: Request) => {
  const identity = await requireIdentity();
  const body = await readJson(req, CreateBody);
  try {
    resolveTimeRange(body.timeRange);
  } catch {
    throw new HttpError(400, "invalid time range", {}, "validation");
  }
  const { workspaceId, sources } = await requestedSources({
    identity,
    sourceIds: body.sourceIds,
    getSource: getSourceById,
  });
  const conversation = await pgConversationStore.create({
    id: randomUUID(),
    userSub: identity.sub,
    workspaceId,
    sourceIds: sources.map((s) => s.id),
    timeRange: body.timeRange,
    max: config.chatConversationsMax,
    retentionDays: config.chatHistoryRetentionDays,
  });
  audit({
    actor: identity,
    action: "chat.create",
    workspaceId,
    resource: { type: "conversation", id: conversation.id },
    detail: { sourceIds: conversation.sourceIds, timeRange: conversation.timeRange },
  });
  return json({ conversation }, { status: 201 });
});

/** Delete every conversation of this person's, at once. */
export const DELETE = route("chat.clear", async () => {
  const identity = await requireIdentity();
  const deleted = await pgConversationStore.removeAll(identity.sub);
  // The count, never the content.
  audit({
    actor: identity,
    action: "chat.delete",
    workspaceId: null,
    detail: { deleted, all: true },
  });
  return json({ deleted });
});
