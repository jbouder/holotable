import { z } from "zod";
import { sourceKind } from "@/lib/sources/registry";
import { serverKind } from "@/lib/sources/server/registry";
import { assertAuthorized, authorizedWorkspaces, HttpError } from "@/lib/auth/authorize";
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
  /** `timescaledb` (SQL) or `prometheus` (PromQL, #385). */
  kind: z.string(),
  /** What its queries are written in: `sql` or `promql`. */
  language: z.string(),
  /** A SQL source's schema and allowlisted table count. */
  schema: z.string().optional(),
  tableCount: z.int().optional(),
  /** A Prometheus source's allowlisted metric count. */
  metricCount: z.int().optional(),
  /** `ok`, `empty`, `never_refreshed`, `stale` or `drifted`; only `ok` and `stale` generate. */
  catalog: z.string(),
});

export function sourceTools(deps: McpDeps): McpTool[] {
  return [
    defineTool({
      name: "list_sources",
      title: "List data sources",
      description:
        "The data sources the caller may query, across every workspace they can reach, or in one workspace. Each has an id (the only way a panel refers to a source), a name, its kind and the language its queries are written in (timescaledb: SQL; prometheus: PromQL), how many tables or metrics it allowlists, and the state of its catalog. Call describe_source for the tables and columns, or the metrics and labels.",
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
              kind: listing.kind,
              language: sourceKind(source.config).language,
              ...("schema" in listing
                ? { schema: listing.schema, tableCount: listing.tableCount }
                : { metricCount: listing.metricCount }),
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
        "One source's catalog and the catalog's health. A SQL source (kind timescaledb) lists every table and column a query may use, with types; only these pass the SQL guard, and hidden columns are not listed and cannot be used. A Prometheus source (kind prometheus) lists the metrics a PromQL expression may select, each with its type (counter, gauge, histogram, summary), help and the labels its series carry; a selector of any other metric is refused. Never where the source lives or how it authenticates.",
      input: z.object({
        sourceId: z.string().min(1).describe("A source id from list_sources."),
      }),
      annotations: READ_ONLY,
      async run(args, { identity }) {
        const live = await liveSource(deps, args.sourceId);
        assertAuthorized(
          identity,
          "source:use",
          { workspaceId: live.workspaceId },
          { type: "source", id: live.id },
        );
        const source = live;
        // Never the admin view: a hidden column stays hidden to an agent, and
        // the view carries no connection detail either way. Each kind's own
        // view (#389): tables and columns, or metrics and labels.
        const { canManage: _, ...view } = serverKind(source).catalogView(
          source,
          catalogHealth(source),
          false,
        );
        return {
          id: source.id,
          workspaceId: source.workspaceId,
          name: source.name,
          kind: source.config.kind,
          language: sourceKind(source.config).language,
          ...view,
        };
      },
    }),
  ];
}
