import { randomUUID } from "node:crypto";
import {
  DuplicateModelName,
  type ModelOwner,
  type ModelStore,
  type StoredModel,
  type WorkspaceModelSettings,
} from "@/lib/db/models";

/**
 * An in-memory model catalog (#439) that keeps the real store's rules: rows
 * are reached only through their owner, names are unique per owner ignoring
 * case, and deleting a workspace's default clears it.
 */
export function memoryModelStore(
  seed: { models?: StoredModel[]; workspaces?: WorkspaceModelSettings[] } = {},
): ModelStore & {
  models: StoredModel[];
  workspaces: Map<string, WorkspaceModelSettings>;
} {
  const models = [...(seed.models ?? [])];
  const workspaces = new Map((seed.workspaces ?? []).map((w) => [w.workspaceId, w]));
  const owns = (owner: ModelOwner, m: StoredModel) =>
    owner.scope === "workspace"
      ? m.scope === "workspace" && m.workspaceId === owner.workspaceId
      : m.scope === "personal" && m.userSub === owner.sub;
  const clash = (owner: ModelOwner, name: string, except?: string) =>
    models.some(
      (m) =>
        owns(owner, m) && m.id !== except && m.name.toLowerCase() === name.toLowerCase(),
    );
  return {
    models,
    workspaces,
    async list(owner) {
      return models.filter((m) => owns(owner, m));
    },
    async get(owner, id) {
      return models.find((m) => m.id === id && owns(owner, m)) ?? null;
    },
    async create(owner, write, actor) {
      if (write.credentials === "keep") throw new Error("nothing to keep");
      if (clash(owner, write.name)) throw new DuplicateModelName("taken");
      const now = new Date().toISOString();
      const row: StoredModel = {
        id: randomUUID(),
        scope: owner.scope,
        workspaceId: owner.scope === "workspace" ? owner.workspaceId : null,
        userSub: owner.scope === "personal" ? owner.sub : null,
        name: write.name,
        provider: write.provider,
        settings: write.settings,
        credentials: write.credentials,
        createdBy: actor,
        updatedBy: actor,
        createdAt: now,
        updatedAt: now,
      };
      models.push(row);
      return row;
    },
    async update(owner, id, write, actor) {
      const row = models.find((m) => m.id === id && owns(owner, m));
      if (!row) return null;
      if (clash(owner, write.name, id)) throw new DuplicateModelName("taken");
      Object.assign(row, {
        name: write.name,
        provider: write.provider,
        settings: write.settings,
        credentials: write.credentials === "keep" ? row.credentials : write.credentials,
        updatedBy: actor,
        updatedAt: new Date().toISOString(),
      });
      return row;
    },
    async delete(owner, id) {
      const at = models.findIndex((m) => m.id === id && owns(owner, m));
      if (at < 0) return false;
      const [gone] = models.splice(at, 1);
      for (const w of workspaces.values()) {
        if (w.workspaceId === gone.workspaceId && w.defaultModel === gone.id) {
          w.defaultModel = null;
        }
      }
      return true;
    },
    async workspace(workspaceId) {
      return workspaces.get(workspaceId) ?? null;
    },
    async saveWorkspace({ workspaceId, defaultModel, allowPersonalKeys }) {
      const row = { workspaceId, defaultModel, allowPersonalKeys };
      workspaces.set(workspaceId, row);
      return row;
    },
  };
}

/** A stored model with sensible defaults. */
export function storedModel(overrides: Partial<StoredModel> = {}): StoredModel {
  return {
    id: randomUUID(),
    scope: "workspace",
    workspaceId: "w",
    userSub: null,
    name: "Workspace model",
    provider: "openai-compatible",
    settings: { baseUrl: "https://api.example.com/v1", model: "ws-model", api: "chat" },
    credentials: null,
    createdBy: "admin",
    updatedBy: "admin",
    createdAt: "2026-10-07T00:00:00.000Z",
    updatedAt: "2026-10-07T00:00:00.000Z",
    ...overrides,
  };
}
