import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { json, route } from "@/lib/http";
import { deleteTemplate, getTemplateById } from "@/lib/db/repo";

export const runtime = "nodejs";

/**
 * Stored templates are the only ones with an id of this shape. A built-in's id
 * (`builtin:<source>:<table>:<signal>`) is derived and has nothing behind it,
 * so it is answered as a plain 404 here rather than reaching a `uuid` column
 * that would refuse it as a driver-level type error.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Delete a template (its author, a workspace source-admin, or a platform
 * admin — the gate a dashboard delete uses, for a resource of the same kind).
 *
 * Hard delete, and safely so: instantiating a template copies its spec, so no
 * dashboard built from one points back at it and there is nothing for a
 * tombstone to keep resolving.
 */
export const DELETE = route(
  "templates.delete",
  async (_req: Request, ctx: RouteContext<"/api/templates/[id]">) => {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    if (!UUID.test(id)) throw new HttpError(404, "template not found");

    const template = await getTemplateById(id);
    if (!template?.workspaceId) throw new HttpError(404, "template not found");

    assertAuthorized(identity, "dashboard:delete", {
      workspaceId: template.workspaceId,
      ownerSub: template.createdBy,
    });

    await deleteTemplate(template.workspaceId, id);
    return json({ ok: true });
  },
);
