import type {
  streamDashboard,
  streamExplorePanel,
  streamSourceDraft,
} from "@/lib/ai/generate";
import type { recordGeneration } from "@/lib/ai/log";
import type { requireModel } from "@/lib/ai/model-resolution";
import type {
  createDashboard,
  getDashboardById,
  getSourceById,
  listDashboards,
  listLinkableDashboards,
  listSources,
  saveDashboardVersion,
} from "@/lib/db/repo";
import type { enforceLlmLimits } from "@/lib/limits/llm";
import type { invalidatePoller } from "@/lib/poller/registry";
import type { secretRefGrants } from "@/lib/secrets/credentials";
import type { ServerSourceKind } from "@/lib/sources/server/registry";
import type { workspacePromptFor } from "@/lib/workspace-prompt-service";

/**
 * Everything the MCP tools reach that touches the database, the sources or
 * the model, named so a test can hand in fakes and the tools' authorization,
 * validation and audit logic run exactly as in production. The real ones
 * are `defaultMcpDeps()` in `./index.ts`.
 */
export interface McpDeps {
  getSource: typeof getSourceById;
  listSources: typeof listSources;
  /** A plan run on its source, through the source's kind. */
  executePlan: ServerSourceKind["execute"];
  listDashboards: typeof listDashboards;
  getDashboard: typeof getDashboardById;
  createDashboard: typeof createDashboard;
  saveDashboardVersion: typeof saveDashboardVersion;
  invalidatePoller: typeof invalidatePoller;
  enforceLlmLimits: typeof enforceLlmLimits;
  /** The caller's model in the workspace (#331): personal, workspace or environment. */
  requireModel: typeof requireModel;
  workspacePromptFor: typeof workspacePromptFor;
  /** The dashboards a generated link may lead to (#375). */
  listLinkableDashboards: typeof listLinkableDashboards;
  streamDashboard: typeof streamDashboard;
  streamExplorePanel: typeof streamExplorePanel;
  streamSourceDraft: typeof streamSourceDraft;
  secretRefGrants: typeof secretRefGrants;
  recordGeneration: typeof recordGeneration;
}
