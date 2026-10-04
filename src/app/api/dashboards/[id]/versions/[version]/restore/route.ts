import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { json, route } from "@/lib/http";
import { audit } from "@/lib/audit";
import {
  getDashboardById,
  getDashboardVersion,
  saveDashboardVersion,
} from "@/lib/db/repo";
import { resolveAndValidateDashboard } from "@/lib/dashboard-service";
import { invalidatePoller } from "@/lib/poller/registry";
import { restoreNote, VersionNumber } from "@/lib/dashboard-versions";

export const runtime = "nodejs";

/**
 * Restore an earlier version (#73).
 *
 * A restore APPENDS a version whose spec is a copy of the old one; it never
 * moves `current_version_id` back to an old row and never edits one
 * (invariant 3), so the history records the restore like any other save.
 *
 * The old spec goes through the same `resolveAndValidateDashboard` as a save.
 * It was valid when it was written, but a source may have been tombstoned, a
 * table dropped from its allowlist, or a column hidden (#12) since — and a
 * restore that skipped the guard would be a way to bring a query back that
 * the guard now refuses. The workspace it resolves to must still be this
 * dashboard's, as on a save.
 */
export const POST = route(
  "dashboards.versions.restore",
  async (
    _req: Request,
    ctx: RouteContext<"/api/dashboards/[id]/versions/[version]/restore">,
  ) => {
    const identity = await requireIdentity();
    const { id, version: raw } = await ctx.params;
    const existing = await getDashboardById(id);
    if (!existing) throw new HttpError(404, "dashboard not found");

    assertAuthorized(
      identity,
      "dashboard:update",
      { workspaceId: existing.workspaceId },
      { type: "dashboard", id },
    );

    const version = VersionNumber.safeParse(raw);
    if (!version.success) throw new HttpError(400, "invalid version");
    if (version.data === existing.version) {
      throw new HttpError(400, `v${version.data} is already the current version`);
    }

    const target = await getDashboardVersion(id, version.data);
    if (!target) throw new HttpError(404, "version not found");

    const { workspaceId } = await resolveAndValidateDashboard(target.spec);
    if (workspaceId !== existing.workspaceId) {
      throw new HttpError(400, "panels reference a different workspace");
    }

    const record = await saveDashboardVersion({
      dashboardId: id,
      createdBy: identity.sub,
      spec: target.spec,
      note: restoreNote(version.data),
    });
    invalidatePoller(id);
    audit({
      actor: identity,
      action: "dashboard.update",
      workspaceId,
      resource: { type: "dashboard", id },
      detail: { version: record.version, restoredFrom: version.data },
    });
    const { spec: _spec, ...summary } = record;
    return json({ dashboard: summary });
  },
);
