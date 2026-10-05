import { z } from "zod";
import { audit } from "@/lib/audit";
import { assertAuthorized, HttpError, requireIdentity } from "@/lib/auth/authorize";
import { pgAnnotationStore } from "@/lib/db/annotations";
import { json, route } from "@/lib/http";
import { WorkspaceId } from "@/lib/workspace-limits";

export const runtime = "nodejs";

const AnnotationId = z.uuid();

/**
 * Delete an annotation (#68). Editor role in the workspace in the path, and
 * only a row of that workspace is deleted: another workspace's id is a 404,
 * the same as one that never existed.
 */
export const DELETE = route(
  "workspaces.annotations.delete",
  async (
    _req: Request,
    ctx: RouteContext<"/api/workspaces/[id]/annotations/[annotationId]">,
  ) => {
    const identity = await requireIdentity();
    const { id, annotationId } = await ctx.params;
    const workspaceId = WorkspaceId.safeParse(id);
    if (!workspaceId.success) throw new HttpError(400, "invalid workspace id");
    assertAuthorized(
      identity,
      "dashboard:update",
      { workspaceId: workspaceId.data },
      { type: "workspace", id: workspaceId.data },
    );
    const parsedId = AnnotationId.safeParse(annotationId);
    if (!parsedId.success) throw new HttpError(404, "annotation not found");
    const removed = await pgAnnotationStore.remove({
      workspaceId: workspaceId.data,
      id: parsedId.data,
    });
    if (!removed) throw new HttpError(404, "annotation not found");
    audit({
      actor: identity,
      action: "annotation.delete",
      workspaceId: workspaceId.data,
      resource: { type: "annotation", id: parsedId.data },
    });
    return json({ ok: true });
  },
);
