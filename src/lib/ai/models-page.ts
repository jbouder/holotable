import { authorizedWorkspaces, can } from "@/lib/auth/authorize";
import type { Identity } from "@/lib/auth/claims";
import { listModels, personalOwner, workspaceModelView } from "@/lib/ai/model-admin";
import type {
  CatalogModelRow,
  ModelsPageData,
  ModelView,
  WorkspaceModelsSection,
} from "@/lib/ai/model-config";
import {
  defaultModelDeps,
  type ModelResolutionDeps,
  storedResolution,
  stubAllowed,
} from "@/lib/ai/model-resolution";
import { usableModels } from "@/lib/ai/models";
import { serverModelList } from "@/lib/ai/server-model-list";
import { config } from "@/lib/config";

/**
 * Who sees the Models page (#441): anyone who may generate somewhere, as AI
 * context's gate, and every visitor in demo mode, where it lists the
 * server's models. A service-account token has no browser.
 */
export function modelsPageVisible(identity: Identity): boolean {
  if (identity.serviceAccount) return false;
  return (
    config.authMode === "demo" ||
    identity.platformAdmin ||
    authorizedWorkspaces(identity, "dashboard:generate").length > 0
  );
}

/** A view's row, its availability decided as resolution would decide it. */
function rowOf(view: ModelView, unavailable: string | null): CatalogModelRow {
  return {
    id: view.id,
    name: view.name,
    provider: view.settings.provider,
    model: view.settings.model,
    unavailable,
    view,
  };
}

/**
 * The page's data. Every workspace the caller generates in gets a section;
 * its source-admins get each model's settings to edit, everyone else the
 * listing they could pick from. Demo mode has the server's models only.
 */
export async function modelsPageData(
  identity: Identity,
  deps: ModelResolutionDeps = defaultModelDeps(),
): Promise<ModelsPageData> {
  const all = serverModelList(deps.env);
  const server = all.map((m, i) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    model: m.model,
    credentialVars: m.credentialVars,
    unavailable: m.unavailable,
    isDefault: i === 0,
  }));
  const base = { server, demo: deps.demo, allowStub: stubAllowed(deps.env) };
  if (deps.demo) {
    return { ...base, workspaces: [], personal: null, personalAppliesIn: [] };
  }

  const ids = authorizedWorkspaces(identity, "dashboard:generate");
  const workspaces: WorkspaceModelsSection[] = await Promise.all(
    ids.map(async (workspaceId) => {
      const [listing, settings] = await Promise.all([
        usableModels(identity, workspaceId, deps),
        deps.store.workspace(workspaceId),
      ]);
      const canManage = can(identity, "source:manage", { workspaceId });
      const views = canManage ? (await workspaceModelView(workspaceId, deps)).models : [];
      const models = listing.models
        .filter((m) => m.scope === "workspace")
        .map((m) => ({
          id: m.id,
          name: m.name,
          provider: m.provider,
          model: m.model,
          unavailable: m.unavailable,
          view: views.find((v) => v.id === m.id) ?? null,
        }));
      return {
        workspaceId,
        canManage,
        defaultModel: settings?.defaultModel ?? null,
        allowPersonalKeys: settings?.allowPersonalKeys ?? false,
        models,
      };
    }),
  );

  const owner = personalOwner(identity);
  const [mine, stored] = await Promise.all([
    listModels(owner, deps),
    deps.store.list(owner),
  ]);
  const personal = mine.map((view) => {
    const row = stored.find((s) => s.id === view.id);
    const resolved = row
      ? storedResolution(view.id, "personal", row, deps.allowlist)
      : null;
    return rowOf(view, resolved && !resolved.ok ? resolved.problem : null);
  });
  return {
    ...base,
    workspaces,
    personal,
    personalAppliesIn: workspaces
      .filter((w) => w.allowPersonalKeys)
      .map((w) => w.workspaceId),
  };
}
