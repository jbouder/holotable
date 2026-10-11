import { HttpError } from "@/lib/auth/authorize";
import type { Identity } from "@/lib/auth/claims";
import type { EffectiveModel, ModelListing, ModelsResponse } from "@/lib/ai/model-config";
import {
  defaultModelDeps,
  environmentResolution,
  type ModelResolutionDeps,
  parseSettings,
  type ResolvedModel,
  storedResolution,
} from "@/lib/ai/model-resolution";
import type { Environment } from "@/lib/config";
import type { StoredModel } from "@/lib/db/models";

/**
 * The model catalog (#437, #439): which models a caller may use in a
 * workspace, and which one a generation gets.
 *
 * The usable set is every **server** model (the environment's, `env:<name>`)
 * ∪ the workspace's own models ∪ the caller's **personal** models, when the
 * workspace allows them. A request may name a model by id; anything outside
 * that set is refused with the same 400 whatever the reason, so a request
 * learns nothing the listing would not tell it.
 */

/** The 400 for a model the catalog does not grant here. It names nothing. */
export const NOT_AVAILABLE = "That model is not available in this workspace.";

/** One usable model: what the listing shows, and how to build it when chosen. */
interface Entry {
  listing: ModelListing;
  resolve(): ResolvedModel;
}

/**
 * The server's models. Until `AI_MODELS_FILE` (#440) there is one, the
 * environment's `AI_PROVIDER`/`AI_MODEL`, named `default`.
 */
export function serverModels(env: Environment): Entry[] {
  const id = "env:default";
  const provider = env.AI_PROVIDER || "openai-compatible";
  return [
    {
      listing: {
        id,
        name: "default",
        provider,
        model: provider === "stub" ? "stub" : (env.AI_MODEL ?? ""),
        scope: "environment" as const,
        unavailable: null,
      },
      resolve: () => environmentResolution(id, env),
    },
  ].map((entry) => {
    const resolved = entry.resolve();
    return {
      ...entry,
      listing: { ...entry.listing, unavailable: resolved.ok ? null : resolved.problem },
    };
  });
}

function storedEntry(
  stored: StoredModel,
  source: "workspace" | "personal",
  deps: ModelResolutionDeps,
): Entry {
  const resolve = () => storedResolution(stored.id, source, stored, deps.allowlist);
  const resolved = resolve();
  const settings = parseSettings(stored);
  return {
    listing: {
      id: stored.id,
      name: stored.name,
      provider: stored.provider,
      model: settings?.model ?? "",
      scope: source,
      unavailable: resolved.ok ? null : resolved.problem,
    },
    resolve,
  };
}

interface Catalog {
  entries: Entry[];
  server: Entry[];
  workspace: Entry[];
  personal: Entry[];
  defaultModel: string | null;
}

/**
 * Everything `identity` may use in `workspaceId`. The workspace is the
 * caller's authorized one; the route has checked it. Demo mode has the
 * server's models only, and a service-account token has no personal ones.
 */
async function catalog(
  identity: Identity,
  workspaceId: string,
  deps: ModelResolutionDeps,
): Promise<Catalog> {
  const server = serverModels(deps.env);
  if (deps.demo) {
    return { entries: server, server, workspace: [], personal: [], defaultModel: null };
  }
  const settings = await deps.store.workspace(workspaceId);
  const allowPersonal = Boolean(settings?.allowPersonalKeys) && !identity.serviceAccount;
  const [own, mine] = await Promise.all([
    deps.store.list({ scope: "workspace", workspaceId }),
    allowPersonal
      ? deps.store.list({ scope: "personal", sub: identity.sub })
      : Promise.resolve([]),
  ]);
  const workspace = own.map((m) => storedEntry(m, "workspace", deps));
  const personal = mine.map((m) => storedEntry(m, "personal", deps));
  return {
    entries: [...server, ...workspace, ...personal],
    server,
    workspace,
    personal,
    defaultModel: settings?.defaultModel ?? null,
  };
}

/**
 * The entry a request without a model gets:
 *
 * 1. the caller's first personal model, where the workspace allows them
 *    (#331's rule; Phase 5 replaces it with the person's remembered pick);
 * 2. the workspace's default, when it is still in the usable set;
 * 3. the server's default.
 */
function defaultEntry(found: Catalog): Entry | null {
  if (found.personal.length > 0) return found.personal[0];
  if (found.defaultModel) {
    const chosen = [...found.server, ...found.workspace].find(
      (e) => e.listing.id === found.defaultModel,
    );
    if (chosen) return chosen;
  }
  return found.server[0] ?? null;
}

/** The listing `GET /api/models` answers, server models first. */
export async function usableModels(
  identity: Identity,
  workspaceId: string,
  deps: ModelResolutionDeps = defaultModelDeps(),
): Promise<ModelsResponse> {
  const found = await catalog(identity, workspaceId, deps);
  return {
    workspaceId,
    models: found.entries.map((e) => e.listing),
    defaultModel: defaultEntry(found)?.listing.id ?? null,
  };
}

/**
 * The model for a generation by `identity` in `workspaceId`: the one
 * requested, which must be in the usable set (else a 400), or the default
 * above. A model that is chosen but broken is reported with its reason and
 * never replaced by another, which may be billed to someone else.
 */
export async function resolveModel(
  input: { identity: Identity; workspaceId: string; modelId?: string | null },
  deps: ModelResolutionDeps = defaultModelDeps(),
): Promise<ResolvedModel> {
  const found = await catalog(input.identity, input.workspaceId, deps);
  if (input.modelId) {
    const chosen = found.entries.find((e) => e.listing.id === input.modelId);
    if (!chosen) throw new HttpError(400, NOT_AVAILABLE);
    return chosen.resolve();
  }
  const chosen = defaultEntry(found);
  if (chosen) return chosen.resolve();
  return {
    ok: false,
    id: null,
    source: "environment",
    problem: "No model configured. Add a server model or a workspace model.",
  };
}

/** {@link resolveModel}, or a 503 that says what to configure. For the generation routes. */
export async function requireModel(
  input: { identity: Identity; workspaceId: string; modelId?: string | null },
  deps?: ModelResolutionDeps,
): Promise<Extract<ResolvedModel, { ok: true }>> {
  const resolved = await resolveModel(input, deps);
  if (!resolved.ok) throw new HttpError(503, resolved.problem);
  return resolved;
}

/** What a page shows about the model a generation here would use. */
export async function effectiveModel(
  input: { identity: Identity; workspaceId: string },
  deps?: ModelResolutionDeps,
): Promise<EffectiveModel> {
  const resolved = await resolveModel(input, deps);
  return resolved.ok
    ? { source: resolved.source, model: resolved.modelId, unavailable: null }
    : { source: resolved.source, model: "", unavailable: resolved.problem };
}

/** {@link effectiveModel} for each workspace, keyed by id. */
export async function effectiveModels(
  identity: Identity,
  workspaceIds: readonly string[],
  deps?: ModelResolutionDeps,
): Promise<Record<string, EffectiveModel>> {
  const entries = await Promise.all(
    [...new Set(workspaceIds)].map(
      async (workspaceId) =>
        [workspaceId, await effectiveModel({ identity, workspaceId }, deps)] as const,
    ),
  );
  return Object.fromEntries(entries);
}
