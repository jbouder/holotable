import { z } from "zod";
import { assertAuthorized } from "@/lib/auth/authorize";
import { defineTool, type McpTool } from "@/lib/mcp/tool";
import type { McpDeps } from "@/lib/mcp/tools/deps";

const ModelSummary = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  model: z.string(),
  /** `environment` (the server's), `workspace` or `personal`. */
  scope: z.string(),
  /** Why it cannot be called right now, when it cannot. */
  unavailable: z.string().optional(),
});

/**
 * The models a client may name when it generates (#442): the same listing
 * `GET /api/models` answers, ids and names only, never settings beyond the
 * model id and never credentials.
 */
export function modelTools(deps: McpDeps): McpTool[] {
  return [
    defineTool({
      name: "list_models",
      title: "List models",
      description:
        "The models the caller may generate with in a workspace: the server's, the workspace's own and, where the workspace allows them, the caller's personal ones. Pass an id (or a server model's name) as `model` to generate_dashboard, generate_panel or generate_source; `defaultModel` is the one used when none is named.",
      input: z.object({
        workspaceId: z.string().min(1).max(128).describe("The workspace to generate in."),
      }),
      output: z.object({
        models: z.array(ModelSummary),
        defaultModel: z.string().nullable(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async run(args, { identity }) {
        assertAuthorized(identity, "source:use", { workspaceId: args.workspaceId });
        const listing = await deps.usableModels(identity, args.workspaceId);
        return {
          models: listing.models.map(({ unavailable, ...m }) => ({
            ...m,
            ...(unavailable ? { unavailable } : {}),
          })),
          defaultModel: listing.defaultModel,
        };
      },
    }),
  ];
}
