import { AnnotationInput } from "@/lib/annotations";
import { audit } from "@/lib/audit";
import { assertAuthorized, HttpError, requireIdentity } from "@/lib/auth/authorize";
import { pgAnnotationStore } from "@/lib/db/annotations";
import { json, readJson, route } from "@/lib/http";
import { WorkspaceId } from "@/lib/workspace-limits";

export const runtime = "nodejs";

/**
 * Write an annotation into a workspace (#68): a deploy marker, an incident
 * range, a note. Editor role in that workspace. The workspace is the path
 * segment, the resource being written, and authorization is the caller's
 * role there from their validated identity. A pipeline posts here with a
 * service-account token once #288 adds them.
 */
export const POST = route(
  "workspaces.annotations.create",
  async (req: Request, ctx: RouteContext<"/api/workspaces/[id]/annotations">) => {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const workspaceId = WorkspaceId.safeParse(id);
    if (!workspaceId.success) throw new HttpError(400, "invalid workspace id");
    assertAuthorized(
      identity,
      "dashboard:update",
      { workspaceId: workspaceId.data },
      { type: "workspace", id: workspaceId.data },
    );
    const annotation = await readJson(req, AnnotationInput, { maxBytes: 8_192 });
    const created = await pgAnnotationStore.create({
      workspaceId: workspaceId.data,
      createdBy: identity.sub,
      annotation,
    });
    audit({
      actor: identity,
      action: "annotation.create",
      workspaceId: workspaceId.data,
      resource: { type: "annotation", id: created.id },
      detail: { kind: created.kind, at: annotation.at, source: created.source },
    });
    return json({ annotation: created }, { status: 201 });
  },
);
