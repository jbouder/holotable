import { z } from "zod";
import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { readJson, json, route } from "@/lib/http";
import {
  getDashboardById,
  saveDashboardVersion,
  softDeleteDashboard,
  updateDashboardMetadata,
} from "@/lib/db/repo";
import { resolveAndValidateDashboard } from "@/lib/dashboard-service";
import { invalidatePoller } from "@/lib/poller/registry";
import { Dashboard } from "@/lib/ir";
import { DashboardDescription, DashboardTags } from "@/lib/dashboard-metadata";
import { VERSION_NOTE_MAX } from "@/lib/editor/session";

export const runtime = "nodejs";

export const GET = route(
  "dashboards.get",
  async (_req: Request, ctx: RouteContext<"/api/dashboards/[id]">) => {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const dashboard = await getDashboardById(id);
    if (!dashboard) throw new HttpError(404, "dashboard not found");

    assertAuthorized(identity, "dashboard:view", {
      workspaceId: dashboard.workspaceId,
    });
    return json({ dashboard });
  },
);

/**
 * `note` is the author's own "what changed" for the version row (#117). It is
 * optional, bounded, and never interpreted: it is stored and displayed, and
 * nothing in execution or authorization reads it.
 */
const UpdateBody = z.object({
  spec: Dashboard,
  note: z.string().max(VERSION_NOTE_MAX).optional(),
});

/** Save a new immutable version of the dashboard (editor). */
export const PUT = route(
  "dashboards.update",
  async (req: Request, ctx: RouteContext<"/api/dashboards/[id]">) => {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const existing = await getDashboardById(id);
    if (!existing) throw new HttpError(404, "dashboard not found");

    const { spec, note } = await readJson(req, UpdateBody);
    const { workspaceId } = await resolveAndValidateDashboard(spec);

    // Authorize against BOTH the existing dashboard workspace and the resolved
    // one; they must match (no cross-workspace moves).
    if (workspaceId !== existing.workspaceId) {
      throw new HttpError(400, "panels reference a different workspace");
    }
    assertAuthorized(identity, "dashboard:update", { workspaceId });

    const record = await saveDashboardVersion({
      dashboardId: id,
      createdBy: identity.sub,
      spec,
      note: note?.trim() || null,
    });
    invalidatePoller(id);
    return json({ dashboard: record });
  },
);

/**
 * Metadata, not a spec edit.
 *
 * `description` and `tags` are columns on the dashboard row and are written in
 * place — no version is appended, because nothing executes them (#119). The
 * title is the opposite case: the spec owns it (`TITLE_AUTHORITY`), so a
 * rename here appends a version whose spec differs only in its title, exactly
 * as renaming in the editor does. A `null` description clears it; an omitted
 * one leaves it alone.
 */
const PatchBody = z
  .object({
    title: Dashboard.shape.title.optional(),
    description: DashboardDescription.nullable().optional(),
    tags: DashboardTags.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to update" });

export const PATCH = route(
  "dashboards.patch",
  async (req: Request, ctx: RouteContext<"/api/dashboards/[id]">) => {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const existing = await getDashboardById(id);
    if (!existing) throw new HttpError(404, "dashboard not found");

    // The workspace comes from the stored row, never from the body, and both
    // halves below are gated on the same one edit permission.
    const { workspaceId } = existing;
    assertAuthorized(identity, "dashboard:update", { workspaceId });

    const patch = await readJson(req, PatchBody);
    let record = { ...existing };

    if (patch.title !== undefined && patch.title !== existing.spec.title) {
      // Deliberately NOT re-validated through `resolveAndValidateDashboard`:
      // the panels are the ones already stored, no SQL and no source reference
      // changes, and failing a rename because a source was tombstoned since
      // the last save would block the one edit that cannot break anything.
      const saved = await saveDashboardVersion({
        dashboardId: id,
        createdBy: identity.sub,
        spec: { ...existing.spec, title: patch.title },
        note: `renamed from "${existing.spec.title}"`.slice(0, VERSION_NOTE_MAX),
      });
      record = { ...record, ...saved };
      invalidatePoller(id);
    }

    if (patch.description !== undefined || patch.tags !== undefined) {
      const updated = await updateDashboardMetadata(workspaceId, id, {
        // `null` clears it and `undefined` leaves it alone, which is exactly
        // what the parsed body already distinguishes — so it is passed through
        // rather than defaulted.
        description: patch.description,
        tags: patch.tags,
      });
      if (!updated) throw new HttpError(404, "dashboard not found");
      record = { ...record, ...updated };
    }

    const { spec: _spec, ...summary } = record;
    return json({ dashboard: summary });
  },
);

/** Delete a dashboard (owner, workspace source-admin, or platform admin). */
export const DELETE = route(
  "dashboards.delete",
  async (_req: Request, ctx: RouteContext<"/api/dashboards/[id]">) => {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const existing = await getDashboardById(id);
    if (!existing) throw new HttpError(404, "dashboard not found");

    assertAuthorized(identity, "dashboard:delete", {
      workspaceId: existing.workspaceId,
      ownerSub: existing.createdBy,
    });

    await softDeleteDashboard(id);
    invalidatePoller(id);
    return json({ ok: true });
  },
);
