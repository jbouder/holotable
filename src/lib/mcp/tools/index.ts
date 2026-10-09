import {
  streamDashboard,
  streamExplorePanel,
  streamSourceDraft,
} from "@/lib/ai/generate";
import { recordGeneration } from "@/lib/ai/log";
import { requireModel } from "@/lib/ai/model-resolution";
import {
  createDashboard,
  getDashboardById,
  getSourceById,
  listDashboards,
  listLinkableDashboards,
  listSources,
  saveDashboardVersion,
} from "@/lib/db/repo";
import { enforceLlmLimits } from "@/lib/limits/llm";
import type { McpTool } from "@/lib/mcp/tool";
import { dashboardTools } from "@/lib/mcp/tools/dashboards";
import type { McpDeps } from "@/lib/mcp/tools/deps";
import { generationTools } from "@/lib/mcp/tools/generate";
import { sourceTools } from "@/lib/mcp/tools/sources";
import { sqlTools } from "@/lib/mcp/tools/sql";
import { invalidatePoller } from "@/lib/poller/registry";
import { secretRefGrants } from "@/lib/secrets/credentials";
import { serverKind } from "@/lib/sources/server/registry";
import { workspacePromptFor } from "@/lib/workspace-prompt-service";

export type { McpDeps } from "@/lib/mcp/tools/deps";

/** The production wiring: the same functions the HTTP routes call. */
export function defaultMcpDeps(): McpDeps {
  return {
    getSource: getSourceById,
    listSources,
    executePlan: (source, plan) => serverKind(source).execute(source, plan),
    listDashboards,
    getDashboard: getDashboardById,
    createDashboard,
    saveDashboardVersion,
    invalidatePoller,
    enforceLlmLimits,
    requireModel,
    workspacePromptFor,
    listLinkableDashboards,
    streamDashboard,
    streamExplorePanel,
    streamSourceDraft,
    secretRefGrants,
    recordGeneration,
  };
}

/** Every tool `/api/mcp` offers, in the order a client lists them. */
export function mcpTools(deps: McpDeps = defaultMcpDeps()): McpTool[] {
  return [
    ...sourceTools(deps),
    ...sqlTools(deps),
    ...dashboardTools(deps),
    ...generationTools(deps),
  ];
}

/** Handed to the client at `initialize`, for the model that drives it. */
export const MCP_INSTRUCTIONS = `Holotable builds monitoring dashboards from SQL over TimescaleDB/PostgreSQL. A dashboard is a spec (the shared IR): panels, each with a viz kind, a source id and one SELECT; the server runs the SQL and renders the result. You write specs; the server owns the data and the time window.

Workflow: list_sources, then describe_source for the tables and columns you may use; write SQL and check it with validate_sql, or try it with run_query (read-only, windowed and capped); then save_dashboard with the spec, or have generate_dashboard / generate_panel draft one and save it after review. A panel's sourceId must be a source id from list_sources, and its SQL may name only that source's catalog. Never add a time filter yourself: name the time column in timeField and the server injects the window.`;
