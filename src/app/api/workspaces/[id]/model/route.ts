import { audit } from "@/lib/audit";
import { assertAuthorized, HttpError, requireIdentity } from "@/lib/auth/authorize";
import { WorkspaceModelInput } from "@/lib/ai/model-config";
import {
  assertConfigurable,
  defaultModelDeps,
  prepareWrite,
  workspaceModelView,
} from "@/lib/ai/model-resolution";
import { json, readJson, route } from "@/lib/http";
import { WorkspaceId } from "@/lib/workspace-limits";

export const runtime = "nodejs";

function workspaceOf(id: string): string {
  const workspaceId = WorkspaceId.safeParse(id);
  if (!workspaceId.success) throw new HttpError(400, "invalid workspace id");
  return workspaceId.data;
}

/**
 * The workspace's model configuration (#331), for whoever holds
 * `source:manage` there: the provider, base URL and model, whether personal
 * keys are allowed, and the key's state (set, with its last four characters;
 * none; or unreadable). Never the key.
 */
export const GET = route(
  "workspaces.model.get",
  async (_req: Request, ctx: RouteContext<"/api/workspaces/[id]/model">) => {
    const identity = await requireIdentity();
    const workspaceId = workspaceOf((await ctx.params).id);
    assertAuthorized(
      identity,
      "source:manage",
      { workspaceId },
      { type: "workspace", id: workspaceId },
    );
    return json(await workspaceModelView(workspaceId));
  },
);

/**
 * Replace the workspace's model configuration. `config: null` goes back to
 * the environment's model; the personal-keys toggle is saved either way. The
 * base URL is held to the address rules, DNS included, before anything is
 * written, and a key left out is kept only for the same origin. Takes effect
 * on the next generation: resolution reads the row every time.
 */
export const PUT = route(
  "workspaces.model.update",
  async (req: Request, ctx: RouteContext<"/api/workspaces/[id]/model">) => {
    const identity = await requireIdentity();
    const workspaceId = workspaceOf((await ctx.params).id);
    assertAuthorized(
      identity,
      "source:manage",
      { workspaceId },
      { type: "workspace", id: workspaceId },
    );
    const deps = defaultModelDeps();
    assertConfigurable(deps);
    const body = await readJson(req, WorkspaceModelInput, { maxBytes: 16_384 });
    const current = await deps.store.workspace(workspaceId);
    const write = body.config
      ? await prepareWrite(body.config, current?.config ?? null, deps)
      : null;
    await deps.store.saveWorkspace({
      workspaceId,
      config: write,
      allowPersonalKeys: body.allowPersonalKeys,
      updatedBy: identity.sub,
    });
    audit({
      actor: identity,
      action: "workspace.model.update",
      workspaceId,
      resource: { type: "workspace", id: workspaceId },
      detail: {
        // Which endpoint and model, never the key: only whether it changed.
        ...(body.config
          ? {
              provider: body.config.settings.provider,
              baseUrlHost: new URL(body.config.settings.baseUrl).host,
              model: body.config.settings.model,
              keyChanged: body.config.apiKey !== undefined,
            }
          : { cleared: current?.config != null }),
        allowPersonalKeys: body.allowPersonalKeys,
      },
    });
    return json(await workspaceModelView(workspaceId, deps));
  },
);
