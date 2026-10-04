import { z } from "zod";
import { assertAuthorized, can, HttpError, requireIdentity } from "@/lib/auth/authorize";
import { json, readJson, route } from "@/lib/http";
import { audit } from "@/lib/audit";
import { getSourceById, updateSource } from "@/lib/db/repo";
import { catalogView, setColumnExposure } from "@/lib/catalog/browse";
import { catalogHealth } from "@/lib/catalog/health";
import { CatalogColumn, CatalogTable, SourceConfig } from "@/lib/registry";

export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" };

/**
 * The catalog browser's view of one source (#123).
 *
 * Anyone who may use the source may browse it, but `catalogView` decides what
 * they see from `source:manage`: every column with its flag for an admin, and
 * the editor's projection, without unexposed columns, for anyone else. The
 * workspace comes from the stored source, never from the request.
 */
export const GET = route(
  "sources.catalog",
  async (_req: Request, ctx: RouteContext<"/api/sources/[id]/catalog">) => {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const source = await getSourceById(id);
    if (!source) throw new HttpError(404, "source not found");

    const scope = { workspaceId: source.workspaceId };
    assertAuthorized(identity, "source:use", scope, { type: "source", id });
    const canManage = can(identity, "source:manage", scope);
    return json(
      { view: catalogView(source, catalogHealth(source), canManage) },
      { headers: NO_STORE },
    );
  },
);

const ExposureBody = z
  .object({
    table: CatalogTable.shape.name,
    column: CatalogColumn.shape.name,
    exposed: z.boolean(),
  })
  .strict();

/**
 * Hide or expose one column (source-admin).
 *
 * This is the only edit the browser makes, and the body names one column, not
 * a catalog. The server applies the flag to the config it stored, so a
 * concurrent refresh or a stale tab cannot slip other changes in with it. The
 * prompt and `validateSql` both read the stored config, so the change takes
 * effect on the next generation and the next execution.
 */
export const PATCH = route(
  "sources.catalog.update",
  async (req: Request, ctx: RouteContext<"/api/sources/[id]/catalog">) => {
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
    const { table, column, exposed } = await readJson(req, ExposureBody);

    const next = setColumnExposure(source.config, table, column, exposed);
    if (!next) throw new HttpError(404, `column not in catalog: ${table}.${column}`);
    const updated = await updateSource(source.workspaceId, id, {
      config: SourceConfig.parse(next),
    });
    if (!updated) throw new HttpError(409, "source is tombstoned and cannot be edited");
    // Hiding a column changes what every generation and execution may read.
    audit({
      actor: identity,
      action: "source.update",
      workspaceId: source.workspaceId,
      resource: { type: "source", id },
      detail: { fields: ["catalog"], table, column, exposed },
    });
    return json(
      { view: catalogView(updated, catalogHealth(updated), true) },
      { headers: NO_STORE },
    );
  },
);
