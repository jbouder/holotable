import { z } from "zod";
import { assertAuthorized, authorizedWorkspaces, HttpError } from "@/lib/auth/authorize";
import { catalogView } from "@/lib/catalog/browse";
import { catalogHealth } from "@/lib/catalog/health";
import { defineTool, type McpTool, READ_ONLY } from "@/lib/mcp/tool";
import type { McpDeps } from "@/lib/mcp/tools/deps";
import type { SourceRecord } from "@/lib/registry";
import { sourceListing } from "@/lib/source-listing";

/**
 * The read side an agent needs before it writes a query: which sources
 * exist, and what each one's catalog looks like. Mirrors `GET /api/sources`,
 * `GET /api/sources/[id]` and `GET /api/sources/[id]/catalog`, with one
 * difference: the full source record — host, port, database, `secret_ref` —
 * never leaves through here, whatever the caller's role. A connection
 * detail is managed in the app, and `secret_ref` is a name even there.
 */

/** A source that may be queried: live and not removed. */
export async function liveSource(deps: McpDeps, sourceId: string): Promise<SourceRecord> {
  const source = await deps.getSource(sourceId);
  if (!source || source.tombstonedAt)
    throw new HttpError(404, "unknown or removed source");
  return source;
}

const SourceSummary = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  schema: z.string(),
  tableCount: z.int(),
  /** `ok`, `empty`, `never_refreshed`, `stale` or `drifted`; only `ok` and `stale` generate. */
  catalog: z.string(),
});

export function sourceTools(deps: McpDeps): McpTool[] {
  return [
    defineTool({
      name: "list_sources",
      title: "List data sources",
      description:
        "The data sources the caller may query, across every workspace they can reach, or in one workspace. Each has an id (the only way a panel refers to a source), a name, the schema it exposes and how many tables, and the state of its catalog. Call describe_source for the tables and columns.",
      input: z.object({
        workspaceId: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe("Limit to one workspace."),
      }),
      output: z.object({ sources: z.array(SourceSummary) }),
      annotations: READ_ONLY,
      async run(args, { identity }) {
        if (args.workspaceId) {
          assertAuthorized(identity, "source:use", { workspaceId: args.workspaceId });
        }
        const sources: z.output<typeof SourceSummary>[] = [];
        for (const workspaceId of authorizedWorkspaces(
          identity,
          "source:use",
          args.workspaceId,
        )) {
          for (const source of await deps.listSources(workspaceId)) {
            const listing = sourceListing(source);
            sources.push({
              id: listing.id,
              workspaceId: listing.workspaceId,
              name: listing.name,
              schema: listing.schema,
              tableCount: listing.tableCount,
              catalog: catalogHealth(source).state,
            });
          }
        }
        return { sources };
      },
    }),

    defineTool({
      name: "describe_source",
      title: "Describe a data source",
      description:
        "One source's catalog: every table and column a query may use, with types, and the catalog's health. Only these tables and columns pass the SQL guard; a query that names anything else is refused. Hidden columns are not listed and cannot be used.",
      input: z.object({
        sourceId: z.string().min(1).describe("A source id from list_sources."),
      }),
      annotations: READ_ONLY,
      async run(args, { identity }) {
        const source = await liveSource(deps, args.sourceId);
        assertAuthorized(
          identity,
          "source:use",
          { workspaceId: source.workspaceId },
          { type: "source", id: source.id },
        );
        // Never the admin view: a hidden column stays hidden to an agent, and
        // the view carries no connection detail either way.
        const { canManage: _, ...view } = catalogView(
          source,
          catalogHealth(source),
          false,
        );
        return {
          id: source.id,
          workspaceId: source.workspaceId,
          name: source.name,
          ...view,
        };
      },
    }),
  ];
}
