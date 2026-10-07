import type {
  streamDashboard,
  streamExplorePanel,
  streamSourceDraft,
} from "@/lib/ai/generate";
import type { recordGeneration } from "@/lib/ai/log";
import type {
  createDashboard,
  getDashboardById,
  getSourceById,
  listDashboards,
  listSources,
  saveDashboardVersion,
} from "@/lib/db/repo";
import type { enforceLlmLimits } from "@/lib/limits/llm";
import type { invalidatePoller } from "@/lib/poller/registry";
import type { secretRefGrants } from "@/lib/secrets/credentials";
import type { executePlan } from "@/lib/timescaledb/client";
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
  executePlan: typeof executePlan;
  listDashboards: typeof listDashboards;
  getDashboard: typeof getDashboardById;
  createDashboard: typeof createDashboard;
  saveDashboardVersion: typeof saveDashboardVersion;
  invalidatePoller: typeof invalidatePoller;
  enforceLlmLimits: typeof enforceLlmLimits;
  workspacePromptFor: typeof workspacePromptFor;
  streamDashboard: typeof streamDashboard;
  streamExplorePanel: typeof streamExplorePanel;
  streamSourceDraft: typeof streamSourceDraft;
  secretRefGrants: typeof secretRefGrants;
  recordGeneration: typeof recordGeneration;
}
