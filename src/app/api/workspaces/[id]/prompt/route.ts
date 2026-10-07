import { audit } from "@/lib/audit";
import { assertAuthorized, HttpError, requireIdentity } from "@/lib/auth/authorize";
import { pgWorkspacePromptStore } from "@/lib/db/workspace-prompts";
import { json, readJson, route } from "@/lib/http";
import { WorkspaceId } from "@/lib/workspace-limits";
import {
  EMPTY_WORKSPACE_PROMPT,
  WorkspacePrompt,
  type WorkspacePromptView,
} from "@/lib/workspace-prompt";
import { validateWorkspacePrompt } from "@/lib/workspace-prompt-service";

export const runtime = "nodejs";

/** Comfortably above the largest body the schema's caps allow. */
const MAX_BODY_BYTES = 64 * 1_024;

function workspaceOf(id: string): string {
  const workspaceId = WorkspaceId.safeParse(id);
  if (!workspaceId.success) throw new HttpError(400, "invalid workspace id");
  return workspaceId.data;
}

/**
 * The workspace's prompt customization (#66). Anyone who may generate there
 * may read it, so an editor can see why the model answered as it did; the
 * workspace is the path segment, the resource being read.
 */
export const GET = route(
  "workspaces.prompt.get",
  async (_req: Request, ctx: RouteContext<"/api/workspaces/[id]/prompt">) => {
    const identity = await requireIdentity();
    const workspaceId = workspaceOf((await ctx.params).id);
    assertAuthorized(
      identity,
      "dashboard:generate",
      { workspaceId },
      { type: "workspace", id: workspaceId },
    );
    const view: WorkspacePromptView = (await pgWorkspacePromptStore.get(workspaceId)) ?? {
      workspaceId,
      prompt: EMPTY_WORKSPACE_PROMPT,
      updatedBy: null,
      updatedAt: null,
    };
    return json(view);
  },
);

/**
 * Replace the workspace's prompt customization, for whoever holds
 * `source:manage` there. The body is the whole customization; an example
 * whose panel fails the IR (the schema) or whose SQL fails the guard against
 * its source (`validateWorkspacePrompt`) refuses the save, so nothing the
 * model is shown as an example is a query the app would not run.
 */
export const PUT = route(
  "workspaces.prompt.update",
  async (req: Request, ctx: RouteContext<"/api/workspaces/[id]/prompt">) => {
    const identity = await requireIdentity();
    const workspaceId = workspaceOf((await ctx.params).id);
    assertAuthorized(
      identity,
      "source:manage",
      { workspaceId },
      { type: "workspace", id: workspaceId },
    );
    const prompt = await readJson(req, WorkspacePrompt, { maxBytes: MAX_BODY_BYTES });
    await validateWorkspacePrompt(prompt, workspaceId);
    const view = await pgWorkspacePromptStore.save({
      workspaceId,
      prompt,
      updatedBy: identity.sub,
    });
    audit({
      actor: identity,
      action: "workspace.prompt.update",
      workspaceId,
      resource: { type: "workspace", id: workspaceId },
      detail: {
        glossaryChars: prompt.glossary.length,
        metricDefinitions: prompt.metricDefinitions.length,
        examples: prompt.examples.length,
      },
    });
    return json(view);
  },
);
