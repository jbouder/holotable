import { z } from "zod";
import {
  requireIdentity,
  assertAuthorized,
  errorResponse,
  HttpError,
} from "@/lib/auth/authorize";
import { readJson, json } from "@/lib/http";
import { listSources, createSource } from "@/lib/db/repo";
import { SourceConfig } from "@/lib/registry";

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

const CreateBody = z.object({
  workspaceId: z.string().min(1).max(128),
  id: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/i, "invalid source id"),
  name: z.string().min(1).max(200),
  config: SourceConfig,
  secretRef: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "secretRef must be an UPPER_SNAKE env family"),
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
