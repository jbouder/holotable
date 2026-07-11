import { z } from "zod";
import {
  requireIdentity,
  assertAuthorized,
  errorResponse,
  HttpError,
} from "@/lib/auth/authorize";
import { readJson } from "@/lib/http";
import { getSourceById } from "@/lib/db/repo";
import { streamDashboard, streamPanel } from "@/lib/ai/generate";
import { Panel } from "@/lib/ir";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("dashboard"),
    sourceId: z.string().min(1),
    prompt: z.string().min(1).max(4000),
  }),
  z.object({
    mode: z.literal("panel"),
    sourceId: z.string().min(1),
    prompt: z.string().min(1).max(4000),
    current: Panel,
  }),
]);

/**
 * Generate a dashboard/panel spec via the LLM. Runs the model exactly once.
 * Authorization: editor on the workspace that OWNS the selected source (the
 * workspace is derived from the trusted source record, never from the request).
 */
export async function POST(req: Request) {
  try {
    const identity = await requireIdentity();
    const body = await readJson(req, Body);

    const source = await getSourceById(body.sourceId);
    if (!source || source.tombstonedAt) {
      throw new HttpError(400, "unknown or removed source");
    }

    assertAuthorized(identity, "dashboard:generate", {
      workspaceId: source.workspaceId,
    });

    const result =
      body.mode === "dashboard"
        ? streamDashboard({ source, prompt: body.prompt })
        : streamPanel({ source, prompt: body.prompt, current: body.current });

    return result.toTextStreamResponse();
  } catch (err) {
    return errorResponse(err);
  }
}
