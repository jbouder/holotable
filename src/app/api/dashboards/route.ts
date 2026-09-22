import { z } from "zod";
import { requireIdentity, assertAuthorized } from "@/lib/auth/authorize";
import { accessibleWorkspaces } from "@/lib/auth/claims";
import { readJson, json, route } from "@/lib/http";
import { listDashboards, createDashboard } from "@/lib/db/repo";
import { resolveAndValidateDashboard } from "@/lib/dashboard-service";
import { Dashboard } from "@/lib/ir";

export const runtime = "nodejs";

/** List dashboards across every workspace the caller can view. */
export const GET = route("dashboards.list", async () => {
  const identity = await requireIdentity();
  const workspaces = accessibleWorkspaces(identity);
  const lists = await Promise.all(workspaces.map((w) => listDashboards(w)));
  return json({ dashboards: lists.flat() });
});

const CreateBody = z.object({ spec: Dashboard });

/**
 * Create a dashboard. The workspace is derived from the trusted source records
 * referenced by the spec (never from a request field), then create is
 * authorized against that workspace.
 */
export const POST = route("dashboards.create", async (req: Request) => {
  const identity = await requireIdentity();
  const { spec } = await readJson(req, CreateBody);

  const { workspaceId } = await resolveAndValidateDashboard(spec);
  assertAuthorized(identity, "dashboard:create", { workspaceId });

  const record = await createDashboard({
    workspaceId,
    createdBy: identity.sub,
    spec,
  });
  return json({ dashboard: record }, { status: 201 });
});
