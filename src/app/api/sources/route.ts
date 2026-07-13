import { z } from "zod";
import {
  requireIdentity,
  assertAuthorized,
  errorResponse,
  HttpError,
} from "@/lib/auth/authorize";
import { readJson, json } from "@/lib/http";
import { listSources, createSource } from "@/lib/db/repo";
import { SourceDraft } from "@/lib/registry";

export const runtime = "nodejs";

/**
 * List sources in a workspace. The `workspaceId` query param scopes the query,
 * but access is authorized against the caller's identity for that workspace
 * (never granted merely because a workspace was named).
 */
export async function GET(req: Request) {
  try {
    const identity = await requireIdentity();
    const workspaceId = new URL(req.url).searchParams.get("workspaceId");
    if (!workspaceId) throw new HttpError(400, "workspaceId is required");

    assertAuthorized(identity, "source:use", { workspaceId });
    const sources = await listSources(workspaceId);
    return json({ sources });
  } catch (err) {
    return errorResponse(err);
  }
}

// The create body IS a drafted source plus the target workspace, so the
// natural-language draft schema and the create contract stay in lockstep.
const CreateBody = SourceDraft.extend({
  workspaceId: z.string().min(1).max(128),
});

/** Create a source (source-admin on the target workspace). */
export async function POST(req: Request) {
  try {
    const identity = await requireIdentity();
    const body = await readJson(req, CreateBody);

    assertAuthorized(identity, "source:manage", { workspaceId: body.workspaceId });

    const source = await createSource({
      id: body.id,
      workspaceId: body.workspaceId,
      name: body.name,
      config: body.config,
      secretRef: body.secretRef,
      createdBy: identity.sub,
    });
    return json({ source }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
