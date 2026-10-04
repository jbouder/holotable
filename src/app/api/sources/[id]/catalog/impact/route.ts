import { z } from "zod";
import { assertAuthorized, HttpError, requireIdentity } from "@/lib/auth/authorize";
import { json, route } from "@/lib/http";
import { getSourceById, sourcePanelStatements } from "@/lib/db/repo";
import type { ColumnImpact } from "@/lib/catalog/browse";
import { hiddenColumnImpact } from "@/lib/catalog/hide-impact";
import { CatalogColumn, CatalogTable } from "@/lib/registry";

export const runtime = "nodejs";

const Params = z.object({
  table: CatalogTable.shape.name,
  column: CatalogColumn.shape.name,
});

/**
 * What hiding one column would break (#267): the current panels on this
 * source that the guard would start refusing.
 *
 * Gated on `source:manage`, like the source's own impact route (#125): the
 * answer lists dashboards, and only the role that can hide the column needs
 * it. The workspace comes from the stored source and scopes the panel query,
 * so this cannot enumerate dashboards elsewhere. The panels' SQL is read here
 * to run the guard and never leaves; the payload is ids and titles.
 */
export const GET = route(
  "sources.catalog.impact",
  async (req: Request, ctx: RouteContext<"/api/sources/[id]/catalog/impact">) => {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const source = await getSourceById(id);
    if (!source) throw new HttpError(404, "source not found");

    assertAuthorized(
      identity,
      "source:manage",
      { workspaceId: source.workspaceId },
      { type: "source", id },
    );

    const search = new URL(req.url).searchParams;
    const parsed = Params.safeParse({
      table: search.get("table") ?? undefined,
      column: search.get("column") ?? undefined,
    });
    if (!parsed.success) throw new HttpError(400, "table and column are required");
    const { table, column } = parsed.data;

    const panels = await sourcePanelStatements(source.workspaceId, id);
    const dashboards = await hiddenColumnImpact(source.config, panels, table, column);
    if (!dashboards)
      throw new HttpError(404, `column not in catalog: ${table}.${column}`);

    const impact: ColumnImpact = { table, column, dashboards };
    return json({ impact }, { headers: { "cache-control": "no-store" } });
  },
);
