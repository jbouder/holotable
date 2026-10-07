import { z } from "zod";
import { audit } from "@/lib/audit";
import { assertAuthorized, authorizedWorkspaces, HttpError } from "@/lib/auth/authorize";
import { resolveAndValidateDashboard } from "@/lib/dashboard-service";
import { VERSION_NOTE_MAX } from "@/lib/editor/session";
import { Dashboard } from "@/lib/ir";
import { StoredDashboard } from "@/lib/ir/upgrade";
import { defineTool, type McpTool, READ_ONLY } from "@/lib/mcp/tool";
import type { McpDeps } from "@/lib/mcp/tools/deps";

/**
 * Dashboards as records: `GET /api/dashboards`, `GET /api/dashboards/[id]`,
 * and `POST /api/dashboards` / `PUT /api/dashboards/[id]` behind one
 * `save_dashboard`. A saved spec goes through exactly what the routes put it
 * through: parsed as a stored spec (so an older `specVersion` is upgraded),
 * every panel's source resolved from the registry and its SQL through the
 * guard, the workspace derived from those trusted records and never from an
 * argument, and only then the `dashboard:create` or `dashboard:update` check.
 */

const DashboardListing = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  tags: z.array(z.string()),
  version: z.int(),
  updatedAt: z.string(),
});

const MAX_LIST = 100;

/** The documented argument is a current spec; what is accepted is any stored one. */
const SaveInput = z.object({
  spec: Dashboard.describe("The dashboard spec (the shared IR)."),
  dashboardId: z
    .uuid()
    .optional()
    .describe("Save a new version of this dashboard; omit to create one."),
  note: z.string().max(VERSION_NOTE_MAX).optional().describe("A note on the version."),
});
const SaveParse = SaveInput.extend({ spec: StoredDashboard });

export function dashboardTools(deps: McpDeps): McpTool[] {
  return [
    defineTool({
      name: "list_dashboards",
      title: "List dashboards",
      description:
        "The dashboards the caller may view, across their workspaces or in one, with an optional search. Call get_dashboard for a spec.",
      input: z.object({
        workspaceId: z.string().min(1).max(128).optional(),
        search: z
          .string()
          .max(200)
          .optional()
          .describe("Words in the title or description."),
        limit: z
          .int()
          .min(1)
          .max(MAX_LIST)
          .optional()
          .describe("Per workspace; 24 by default."),
      }),
      output: z.object({ dashboards: z.array(DashboardListing), total: z.int() }),
      annotations: READ_ONLY,
      async run(args, { identity }) {
        if (args.workspaceId) {
          assertAuthorized(identity, "dashboard:view", { workspaceId: args.workspaceId });
        }
        const dashboards: z.output<typeof DashboardListing>[] = [];
        let total = 0;
        for (const workspaceId of authorizedWorkspaces(
          identity,
          "dashboard:view",
          args.workspaceId,
        )) {
          const page = await deps.listDashboards(workspaceId, {
            search: args.search,
            limit: args.limit,
            userSub: identity.sub,
          });
          total += page.total;
          for (const d of page.dashboards) {
            dashboards.push({
              id: d.id,
              workspaceId: d.workspaceId,
              title: d.title,
              description: d.description ?? null,
              tags: d.tags,
              version: d.version,
              updatedAt: d.updatedAt,
            });
          }
        }
        return { dashboards, total };
      },
    }),

    defineTool({
      name: "get_dashboard",
      title: "Get a dashboard",
      description:
        "One dashboard with its current spec: title, time range, refresh cadence, panels (each with its viz kind, its source id and its SQL), variables and layout.",
      input: z.object({ dashboardId: z.uuid() }),
      annotations: READ_ONLY,
      async run(args, { identity }) {
        const record = await deps.getDashboard(args.dashboardId);
        if (!record) throw new HttpError(404, "dashboard not found");
        assertAuthorized(
          identity,
          "dashboard:view",
          { workspaceId: record.workspaceId },
          { type: "dashboard", id: record.id },
        );
        return { dashboard: record };
      },
    }),

    defineTool({
      name: "save_dashboard",
      title: "Save a dashboard",
      description:
        "Create a dashboard from a spec, or save a new version of an existing one. The spec is validated against the IR and every panel's SQL against the guard and its source's catalog; a failure names the panel. The workspace is the one the panels' sources belong to.",
      input: SaveInput,
      parse: SaveParse,
      output: z.object({
        id: z.string(),
        workspaceId: z.string(),
        title: z.string(),
        version: z.int(),
        updatedAt: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      async run(args, { identity }) {
        const { spec } = args;
        const { workspaceId } = await resolveAndValidateDashboard(spec, deps.getSource);

        if (args.dashboardId) {
          const existing = await deps.getDashboard(args.dashboardId);
          if (!existing) throw new HttpError(404, "dashboard not found");
          if (workspaceId !== existing.workspaceId) {
            throw new HttpError(400, "panels reference a different workspace");
          }
          assertAuthorized(
            identity,
            "dashboard:update",
            { workspaceId },
            { type: "dashboard", id: existing.id },
          );
          const record = await deps.saveDashboardVersion({
            dashboardId: existing.id,
            createdBy: identity.sub,
            spec,
            note: args.note?.trim() || null,
          });
          deps.invalidatePoller(existing.id);
          audit({
            actor: identity,
            action: "dashboard.update",
            workspaceId,
            resource: { type: "dashboard", id: existing.id },
            detail: { version: record.version, via: "mcp" },
          });
          return summary(record);
        }

        assertAuthorized(identity, "dashboard:create", { workspaceId });
        const record = await deps.createDashboard({
          workspaceId,
          createdBy: identity.sub,
          spec,
        });
        audit({
          actor: identity,
          action: "dashboard.create",
          workspaceId,
          resource: { type: "dashboard", id: record.id },
          detail: { via: "mcp" },
        });
        return summary(record);
      },
    }),
  ];
}

function summary(record: {
  id: string;
  workspaceId: string;
  title: string;
  version: number;
  updatedAt: string;
}) {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    title: record.title,
    version: record.version,
    updatedAt: record.updatedAt,
  };
}
