import type { EffectiveModel } from "@/lib/ai/model-config";
import { effectiveModels } from "@/lib/ai/model-resolution";
import { authorizedWorkspaces, can } from "@/lib/auth/authorize";
import { accessibleWorkspaces, type Identity } from "@/lib/auth/claims";
import { type CatalogHealth, catalogHealth } from "@/lib/catalog/health";
import { listSources } from "@/lib/db/repo";
import { exploreDefaultsOf } from "@/lib/preferences";
import { requestPreferences } from "@/lib/preferences-server";
import { buildStarters } from "@/lib/prompts/starters";
import { isSqlSource } from "@/lib/sources/registry";

/** A source as the Chat page offers it: names and a verdict, never the catalog. */
export interface ChatSourceOption {
  id: string;
  name: string;
  workspaceId: string;
  kind: string;
  /** Server-decided, as `/api/generate` decides it. */
  catalog: CatalogHealth;
  /** Whether this caller may refresh it (`source:manage` here). */
  canRefresh: boolean;
  /** Questions built from its catalog on the server. */
  starters: string[];
}

export interface ChatPageData {
  sources: ChatSourceOption[];
  /** Per workspace: each may have its own model, or the caller theirs (#331). */
  models: Record<string, EffectiveModel>;
  canManageSources: boolean;
  /** The range a new conversation starts with, from the person's preferences. */
  defaultFrom: string;
}

/**
 * What the Chat page needs for this person (#416): every source they may use
 * (`source:use`, a viewer's role, wider than Explore's editor), the model per
 * workspace, and where a new conversation starts.
 */
export async function chatPageData(identity: Identity): Promise<ChatPageData> {
  const workspaces = accessibleWorkspaces(identity).filter((w) =>
    can(identity, "source:use", { workspaceId: w }),
  );
  const lists = await Promise.all(workspaces.map((w) => listSources(w)));
  const sources = lists.flat().map((s) => ({
    id: s.id,
    name: s.name,
    workspaceId: s.workspaceId,
    kind: s.kind,
    catalog: catalogHealth(s),
    canRefresh: can(identity, "source:manage", { workspaceId: s.workspaceId }),
    starters: isSqlSource(s) ? buildStarters(s, "panel") : [],
  }));
  return {
    sources,
    models: await effectiveModels(identity, workspaces),
    canManageSources: authorizedWorkspaces(identity, "source:manage").length > 0,
    defaultFrom: exploreDefaultsOf(await requestPreferences(identity)).timeRange,
  };
}
