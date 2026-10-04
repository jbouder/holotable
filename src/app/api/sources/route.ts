import { z } from "zod";
import { requireIdentity, assertAuthorized, can, HttpError } from "@/lib/auth/authorize";
import { readJson, json, route } from "@/lib/http";
import { audit } from "@/lib/audit";
import { listSources, createSource } from "@/lib/db/repo";
import { catalogHealth } from "@/lib/catalog/health";
import { SourceDraft } from "@/lib/registry";
import { sourceListing } from "@/lib/source-listing";
import { requireGrantedSecretRef } from "@/lib/secrets/http";

export const runtime = "nodejs";

/**
 * List sources in a workspace. The `workspaceId` query param scopes the query,
 * but access is authorized against the caller's identity for that workspace
 * (never granted merely because a workspace was named).
 *
 * `catalogHealth` is decided here rather than in the browser so the list, the
 * pickers and the refusal in `/api/generate` all read the same judgement from
 * the same `CATALOG_STALE_AFTER_DAYS`.
 *
 * A source admin gets the full records, which the edit form needs. Anyone else
 * gets `sourceListing()`: no connection details, no `secret_ref`, and no
 * catalog, so no column an admin hid (#123). `canManage` says which shape
 * this is.
 */
export const GET = route("sources.list", async (req: Request) => {
  const identity = await requireIdentity();
  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  if (!workspaceId) throw new HttpError(400, "workspaceId is required");

  assertAuthorized(identity, "source:use", { workspaceId });
  const canManage = can(identity, "source:manage", { workspaceId });
  const sources = await listSources(workspaceId);
  return json({
    canManage,
    sources: canManage ? sources : sources.map(sourceListing),
    catalogHealth: Object.fromEntries(sources.map((s) => [s.id, catalogHealth(s)])),
  });
});

// The create body IS a drafted source plus the target workspace, so the
// natural-language draft schema and the create contract stay in lockstep.
const CreateBody = SourceDraft.extend({
  workspaceId: z.string().min(1).max(128),
});

/** Create a source (source-admin on the target workspace). */
export const POST = route("sources.create", async (req: Request) => {
  const identity = await requireIdentity();
  const body = await readJson(req, CreateBody);

  assertAuthorized(identity, "source:manage", { workspaceId: body.workspaceId });
  requireGrantedSecretRef(body.secretRef, body.workspaceId);

  const source = await createSource({
    id: body.id,
    workspaceId: body.workspaceId,
    name: body.name,
    config: body.config,
    secretRef: body.secretRef,
    createdBy: identity.sub,
  });
  audit({
    actor: identity,
    action: "source.create",
    workspaceId: body.workspaceId,
    resource: { type: "source", id: source.id },
    detail: { secretRef: body.secretRef },
  });
  return json({ source }, { status: 201 });
});
