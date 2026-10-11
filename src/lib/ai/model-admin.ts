import { assertAuthorized, HttpError } from "@/lib/auth/authorize";
import type { Identity } from "@/lib/auth/claims";
import type {
  ModelConfigInput,
  ModelInput,
  ModelView,
  WorkspaceModelInput,
  WorkspaceModelView,
} from "@/lib/ai/model-config";
import {
  assertConfigurable,
  defaultModelDeps,
  type ModelResolutionDeps,
  configForUse,
  modelForTest,
  modelView,
  prepareWrite,
} from "@/lib/ai/model-resolution";
import { baseUrlRefusal } from "@/lib/ai/guarded-fetch";
import { type DiscoveredModel, ModelListError } from "@/lib/ai/providers/server/list";
import { discoverModels } from "@/lib/ai/providers/server/registry";
import { serverModels } from "@/lib/ai/models";
import type { Model } from "@/lib/ai/provider";
import { endpointHost, kindOf } from "@/lib/ai/providers/registry";
import { DuplicateModelName, type ModelOwner, type StoredModel } from "@/lib/db/models";
import { WorkspaceId } from "@/lib/workspace-limits";

/**
 * What the model catalog routes do (#439), as functions over the store so
 * the routes stay thin and the rules are testable. Every write goes through
 * `prepareWrite`: a typed base URL through the base URL guard, credentials
 * held to the kind's shape and kept only for the same origin, every secret
 * registered with the log's redaction. Demo mode refuses every write.
 */

/** A workspace id from a path, or a 400. */
export function workspaceOf(id: string): string {
  const parsed = WorkspaceId.safeParse(id);
  if (!parsed.success) throw new HttpError(400, "invalid workspace id");
  return parsed.data;
}

/** The workspace routes are for whoever holds `source:manage` there. */
export function assertManages(identity: Identity, workspaceId: string): void {
  assertAuthorized(
    identity,
    "source:manage",
    { workspaceId },
    { type: "workspace", id: workspaceId },
  );
}

/** A service-account token is not a person and has no personal models. */
export function person(identity: Identity): Identity {
  if (identity.serviceAccount) {
    throw new HttpError(403, "A service-account token has no personal models.");
  }
  return identity;
}

export const personalOwner = (identity: Identity): ModelOwner => ({
  scope: "personal",
  sub: person(identity).sub,
});

export const workspaceOwner = (workspaceId: string): ModelOwner => ({
  scope: "workspace",
  workspaceId,
});

function views(models: StoredModel[]): ModelView[] {
  return models.map(modelView).filter((v): v is ModelView => v !== null);
}

/** An owner's models as a page sees them: never the credentials. */
export async function listModels(
  owner: ModelOwner,
  deps: ModelResolutionDeps = defaultModelDeps(),
): Promise<ModelView[]> {
  return views(await deps.store.list(owner));
}

/** A workspace's models, its default and its toggle, for a source-admin. */
export async function workspaceModelView(
  workspaceId: string,
  deps: ModelResolutionDeps = defaultModelDeps(),
): Promise<WorkspaceModelView> {
  const [settings, models] = await Promise.all([
    deps.store.workspace(workspaceId),
    listModels(workspaceOwner(workspaceId), deps),
  ]);
  const defaultModel = settings?.defaultModel ?? null;
  return {
    workspaceId,
    models,
    defaultModel,
    config: models.find((m) => m.id === defaultModel) ?? null,
    allowPersonalKeys: settings?.allowPersonalKeys ?? false,
  };
}

function duplicate(err: unknown): never {
  if (err instanceof DuplicateModelName) {
    throw new HttpError(409, "Another model here already has that name.");
  }
  throw err;
}

export async function createModel(
  owner: ModelOwner,
  input: ModelInput,
  actor: string,
  deps: ModelResolutionDeps = defaultModelDeps(),
): Promise<ModelView> {
  assertConfigurable(deps);
  const write = await prepareWrite(input, null, deps);
  // A new model has nothing stored to keep: no credentials is none.
  const credentials = write.credentials === "keep" ? null : write.credentials;
  const created = await deps.store
    .create(owner, { ...write, credentials, name: input.name }, actor)
    .catch(duplicate);
  return modelView(created) as ModelView;
}

/** Replace a model's name and configuration. A 404 when the owner has no such model. */
export async function updateModel(
  owner: ModelOwner,
  id: string,
  input: ModelInput,
  actor: string,
  deps: ModelResolutionDeps = defaultModelDeps(),
): Promise<ModelView> {
  assertConfigurable(deps);
  const current = await deps.store.get(owner, id);
  if (!current) throw new HttpError(404, "model not found");
  const write = await prepareWrite(input, current, deps);
  const updated = await deps.store
    .update(owner, id, { ...write, name: input.name }, actor)
    .catch(duplicate);
  if (!updated) throw new HttpError(404, "model not found");
  return modelView(updated) as ModelView;
}

/** A 404 when the owner has no such model. Deleting the workspace's default clears it. */
export async function deleteModel(
  owner: ModelOwner,
  id: string,
  deps: ModelResolutionDeps = defaultModelDeps(),
): Promise<void> {
  assertConfigurable(deps);
  if (!(await deps.store.delete(owner, id))) throw new HttpError(404, "model not found");
}

/**
 * A configuration as a model, for "Test connection": the form's, with the
 * stored credentials of `modelId` when the form left them out (same origin
 * only). Without `modelId` it is an unsaved model, with only what it carries.
 */
export async function modelToTest(
  owner: ModelOwner,
  input: ModelConfigInput,
  modelId: string | null,
  deps: ModelResolutionDeps = defaultModelDeps(),
): Promise<Model> {
  assertConfigurable(deps);
  let current: StoredModel | null = null;
  if (modelId) {
    current = await deps.store.get(owner, modelId);
    if (!current) throw new HttpError(404, "model not found");
  }
  return modelForTest(input, current, deps);
}

/** What "List models" answers (#443): the vendor's ids, or why not, in words safe to show. */
export type DiscoverResult =
  | { ok: true; models: DiscoveredModel[] }
  | { ok: false; message: string };

/**
 * The models a configuration's vendor offers, for "List models": the form's
 * settings, with the stored credentials of `modelId` when the form left them
 * out (same origin only). A kind that cannot list is a 400.
 */
export async function modelsToDiscover(
  owner: ModelOwner,
  input: ModelConfigInput,
  modelId: string | null,
  deps: ModelResolutionDeps = defaultModelDeps(),
): Promise<DiscoverResult> {
  assertConfigurable(deps);
  let current: StoredModel | null = null;
  if (modelId) {
    current = await deps.store.get(owner, modelId);
    if (!current) throw new HttpError(404, "model not found");
  }
  const { settings, credentials } = await configForUse(input, current, deps);
  const listing = discoverModels(settings, credentials, deps.allowlist);
  if (!listing) {
    throw new HttpError(
      400,
      `${kindOf(settings).label} does not list its models; type the model id.`,
    );
  }
  try {
    return { ok: true, models: await listing };
  } catch (err) {
    if (err instanceof ModelListError) return { ok: false, message: err.message };
    const refused = baseUrlRefusal(err);
    if (refused) return { ok: false, message: refused.message };
    return {
      ok: false,
      message: "The provider could not be reached to list its models.",
    };
  }
}

/**
 * Save a workspace's default and toggle. The default must be one of the
 * workspace's own models or a server model; anything else is a 400.
 */
export async function saveWorkspaceModelSettings(
  workspaceId: string,
  input: WorkspaceModelInput,
  actor: string,
  deps: ModelResolutionDeps = defaultModelDeps(),
): Promise<WorkspaceModelView> {
  assertConfigurable(deps);
  if (input.defaultModel !== null) {
    const known =
      serverModels(deps.env).some((m) => m.listing.id === input.defaultModel) ||
      (await deps.store.get(workspaceOwner(workspaceId), input.defaultModel)) !== null;
    if (!known) throw new HttpError(400, "That model is not one of this workspace's.");
  }
  await deps.store.saveWorkspace({
    workspaceId,
    defaultModel: input.defaultModel,
    allowPersonalKeys: input.allowPersonalKeys,
    updatedBy: actor,
  });
  return workspaceModelView(workspaceId, deps);
}

/** What an audit row says about a model write: which endpoint and model, never a credential. */
export function modelAuditDetail(input: ModelInput): Record<string, unknown> {
  return {
    name: input.name,
    provider: input.settings.provider,
    endpointHost: endpointHost(input.settings),
    model: input.settings.model,
    keyChanged: input.credentials !== undefined,
  };
}
