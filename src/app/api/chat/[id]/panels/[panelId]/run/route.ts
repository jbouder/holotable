import { audit } from "@/lib/audit";
import { HttpError, requireIdentity } from "@/lib/auth/authorize";
import {
  conversationRetention,
  conversationScope,
  ownConversation,
  PanelId,
  PanelRunBody,
  requireUsable,
  runStoredPanel,
  storedPanel,
  usableSources,
} from "@/lib/chat/conversations";
import { PANEL_UNAVAILABLE, readStoredChatMessage } from "@/lib/chat/persist";
import { pgConversationStore } from "@/lib/db/conversations";
import { getSourceById } from "@/lib/db/repo";
import { json, readJson, route } from "@/lib/http";
import { queryStatement } from "@/lib/ir";
import { rowFilterHttpError } from "@/lib/row-scope";
import { resolveTimeRange } from "@/lib/time";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Run a drawn panel again (#416): after a reload, on a range change, on Re-run
 * and on live refresh. The spec comes from the stored message and is checked
 * against its source's catalog as it is now, under the caller's row scope;
 * the window is the conversation's, or the one asked for, resolved here.
 */
export const POST = route(
  "chat.panel.run",
  async (req: Request, ctx: RouteContext<"/api/chat/[id]/panels/[panelId]/run">) => {
    const identity = await requireIdentity();
    const params = await ctx.params;
    const conversation = await ownConversation(params.id, identity, pgConversationStore);
    const panelId = PanelId.safeParse(params.panelId);
    if (!panelId.success) throw new HttpError(404, "panel not found");
    const body = await readJson(req, PanelRunBody);
    const timeRange = body.timeRange ?? conversation.timeRange;
    try {
      resolveTimeRange(timeRange);
    } catch {
      throw new HttpError(400, "invalid time range", {}, "validation");
    }

    const stored = await pgConversationStore.messages(
      conversation.id,
      identity.sub,
      conversationRetention(),
    );
    const panel = storedPanel(
      stored.map(readStoredChatMessage).filter((m) => m !== null),
      panelId.data,
    );
    if (!panel) throw new HttpError(404, PANEL_UNAVAILABLE);

    const { sources } = await usableSources({
      identity,
      conversation,
      getSource: getSourceById,
    });
    requireUsable(sources);
    const sourceId = panel.query.sourceId;

    try {
      const run = await runStoredPanel({
        panel,
        scope: conversationScope(conversation, sources, identity, timeRange),
        onQuery: (outcome, stage) =>
          audit({
            actor: identity,
            action: "query.execute",
            workspaceId: conversation.workspaceId,
            resource: { type: "source", id: sourceId },
            outcome,
            detail: {
              via: "chat",
              conversationId: conversation.id,
              panelId: panelId.data,
              ...queryStatement(panel.query),
              stage,
            },
          }),
      });
      return json(run);
    } catch (err) {
      // A statement the row filter cannot narrow is named like any refusal.
      throw rowFilterHttpError(err);
    }
  },
);
