import { z } from "zod";
import {
  requireIdentity,
  assertAuthorized,
  errorResponse,
} from "@/lib/auth/authorize";
import { readJson } from "@/lib/http";
import { streamSourceDraft } from "@/lib/ai/generate";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  workspaceId: z.string().min(1).max(128),
  prompt: z.string().min(1).max(4000),
});

/**
 * Draft a data source from natural language. Runs the model exactly once and
 * streams back a SourceDraft (safe connection config + table catalog, never
 * credentials or data) for the user to review before creating it.
 *
 * Authorization mirrors source creation: source:manage on the target workspace,
 * which is taken from the request but validated against the caller's identity.
 */
export async function POST(req: Request) {
  try {
    const identity = await requireIdentity();
    const body = await readJson(req, Body);

    assertAuthorized(identity, "source:manage", {
      workspaceId: body.workspaceId,
    });

    const result = streamSourceDraft({ prompt: body.prompt });
    return result.toTextStreamResponse();
  } catch (err) {
    return errorResponse(err);
  }
}
