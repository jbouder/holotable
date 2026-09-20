import { z } from "zod";
import type { UIMessage } from "ai";
import {
  requireIdentity,
  assertAuthorized,
  errorResponse,
  HttpError,
} from "@/lib/auth/authorize";
import { readJson } from "@/lib/http";
import { getDashboardById, getSourceById } from "@/lib/db/repo";
import { resolveChatSources, streamDashboardChat } from "@/lib/ai/chat";

export const runtime = "nodejs";
export const maxDuration = 60;

// UIMessage has a rich, evolving shape owned by the AI SDK; we validate the
// envelope (a bounded, non-empty array) and let convertToModelMessages enforce
// the rest. The SQL/query surface is guarded server-side regardless of input.
const Body = z.object({
  messages: z.array(z.unknown()).min(1).max(100),
});

/**
 * Read-only chat scoped to a single dashboard. Authorization: viewer on the
 * dashboard's workspace. The model may fetch fresh data only from the sources
 * this dashboard already references AND that the caller may use — each is
 * re-resolved and re-authorized in `resolveChatSources`; unavailable ones are
 * silently omitted (never surfaced), mirroring the poller's tombstone handling.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const identity = await requireIdentity();
    const { id } = await params;
    const body = await readJson(req, Body);

    const dashboard = await getDashboardById(id);
    if (!dashboard) throw new HttpError(404, "dashboard not found");
    assertAuthorized(identity, "dashboard:view", {
      workspaceId: dashboard.workspaceId,
    });

    const sources = await resolveChatSources({
      identity,
      dashboard: dashboard.spec,
      getSource: getSourceById,
    });

    const result = await streamDashboardChat({
      dashboard: dashboard.spec,
      sources,
      messages: body.messages as UIMessage[],
    });

    return result.toUIMessageStreamResponse();
  } catch (err) {
    return errorResponse(err);
  }
}
