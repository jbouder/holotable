import { z } from "zod";
import {
  requireIdentity,
  assertAuthorized,
  errorResponse,
} from "@/lib/auth/authorize";
import { accessibleWorkspaces } from "@/lib/auth/claims";
import { readJson, json } from "@/lib/http";
import { listDashboards, createDashboard } from "@/lib/db/repo";
import { resolveAndValidateDashboard } from "@/lib/dashboard-service";
import { Dashboard } from "@/lib/ir";

export const runtime = "nodejs";

/** List dashboards across every workspace the caller can view. */
export async function GET() {
  try {
    const identity = await requireIdentity();
    const workspaces = accessibleWorkspaces(identity);
    const lists = await Promise.all(workspaces.map((w) => listDashboards(w)));
    return json({ dashboards: lists.flat() });
  } catch (err) {
    return errorResponse(err);
  }
}

const CreateBody = z.object({ spec: Dashboard });

/**
 * Create a dashboard. The workspace is derived from the trusted source records
 * referenced by the spec (never from a request field), then create is
 * authorized against that workspace.
 */
export async function POST(req: Request) {
  try {
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
  } catch (err) {
    return errorResponse(err);
  }
}
