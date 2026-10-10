import type { UIMessage } from "ai";
import { z } from "zod";
import { requireIdentity } from "@/lib/auth/authorize";
import { HttpError } from "@/lib/auth/authorize";
import {
  requestedSources,
  SourceIds,
  TurnBody,
  UnkeptHistory,
} from "@/lib/chat/conversations";
import { chatTurnResponse } from "@/lib/chat/turn";
import { getSourceById } from "@/lib/db/repo";
import { TimeRange } from "@/lib/ir";
import { readJson, route } from "@/lib/http";
import { resolveTimeRange } from "@/lib/time";

export const runtime = "nodejs";
export const maxDuration = 60;

/** The history rides along, reduced by the page, so the body is capped. */
const MAX_BODY_BYTES = 512 * 1024;

const Body = z
  .object({
    sourceIds: SourceIds,
    timeRange: TimeRange,
    history: UnkeptHistory,
    message: TurnBody.shape.message,
  })
  .strict();

/**
 * One turn of a conversation that is not kept (#416): for someone who turned
 * Keep my conversations off. Nothing is stored, so the page sends the history
 * it holds, each panel already reduced to its sample; it is untrusted like any
 * request, reaches the model only through the same tools (a drawn panel's
 * output as its sample), and can widen nothing. The sources are checked here
 * as when a conversation is made: `source:use` on each, one workspace.
 */
export const POST = route("chat.turn.unkept", async (req: Request) => {
  const identity = await requireIdentity();
  const body = await readJson(req, Body, { maxBytes: MAX_BODY_BYTES });
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
  return chatTurnResponse({
    identity,
    workspaceId,
    sources,
    timeRange: body.timeRange,
    messages: [...(body.history as UIMessage[]), body.message as UIMessage],
    abortSignal: req.signal,
  });
});
