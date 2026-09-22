import { z } from "zod";
import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { readJson, route } from "@/lib/http";
import { getSourceById } from "@/lib/db/repo";
import {
  streamDashboard,
  streamDashboardRefinement,
  streamPanel,
  streamExplorePanel,
} from "@/lib/ai/generate";
import { catalogHealth, catalogRefusal } from "@/lib/catalog/health";
import { enforceLlmLimits } from "@/lib/limits/llm";
import { Dashboard, Panel } from "@/lib/ir";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("dashboard"),
    sourceId: z.string().min(1),
    prompt: z.string().min(1).max(4000),
  }),
  z.object({
    mode: z.literal("dashboard-refine"),
    sourceId: z.string().min(1),
    prompt: z.string().min(1).max(4000),
    current: Dashboard,
  }),
  z.object({
    mode: z.literal("panel"),
    sourceId: z.string().min(1),
    prompt: z.string().min(1).max(4000),
    current: Panel,
  }),
  z.object({
    mode: z.literal("explore"),
    sourceId: z.string().min(1),
    prompt: z.string().min(1).max(4000),
  }),
]);

/**
 * Generate a dashboard/panel spec via the LLM. Runs the model exactly once.
 * Authorization: editor on the workspace that OWNS the selected source (the
 * workspace is derived from the trusted source record, never from the request).
 * Then the catalog is checked, and the workspace's rate limit and token budget
 * are enforced; over either, the request is refused with 429 before the model
 * is called.
 *
 * The catalog check comes before the limits deliberately: a source whose
 * tables were never verified cannot produce working SQL, and spending a
 * workspace's rate allowance to be told so is the wrong order. The refusal is
 * a 400 that names the source and the fix.
 */
export const POST = route("generate", async (req: Request) => {
  const identity = await requireIdentity();
  const body = await readJson(req, Body);

  const source = await getSourceById(body.sourceId);
  if (!source || source.tombstonedAt) {
    throw new HttpError(400, "unknown or removed source");
  }

  assertAuthorized(identity, "dashboard:generate", {
    workspaceId: source.workspaceId,
  });

  const refusal = catalogRefusal(source, catalogHealth(source));
  if (refusal) throw new HttpError(400, refusal);

  const usage = await enforceLlmLimits({
    identity,
    workspaceId: source.workspaceId,
    route: "generate",
  });
  const onUsage = usage.record;

  // A ternary rather than `let result` + if/else: the latter gives `result`
  // an implicit `any`, which loses the streamObject result type here.
  const result =
    body.mode === "dashboard"
      ? streamDashboard({ source, prompt: body.prompt, onUsage })
      : body.mode === "dashboard-refine"
        ? streamDashboardRefinement({
            source,
            prompt: body.prompt,
            current: body.current,
            onUsage,
          })
        : body.mode === "explore"
          ? streamExplorePanel({ source, prompt: body.prompt, onUsage })
          : streamPanel({ source, prompt: body.prompt, current: body.current, onUsage });

  return result.toTextStreamResponse();
});
