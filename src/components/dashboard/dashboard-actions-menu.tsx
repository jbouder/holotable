"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  BookmarkPlus,
  Check,
  Download,
  Loader2,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import type { Dashboard } from "@/lib/ir";
import { type ApiError, readApiError } from "@/lib/errors";
import { useSaveAsTemplate } from "@/components/templates/SaveAsTemplate";
import { ErrorDisplay } from "@/components/ui/error-display";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/menu";

/**
 * The dashboard view's occasional actions — export, save as template,
 * delete — behind one trigger, so the action row keeps only what is used
 * while watching a dashboard. Rendered only when at least one item is
 * available; each item appears only for a caller already authorized for it
 * on the server, and every route behind them re-checks.
 */
export function DashboardActionsMenu({
  dashboardId,
  title,
  workspaceId,
  spec,
  canSaveTemplate,
  canDelete,
}: {
  dashboardId: string;
  title: string;
  workspaceId: string;
  spec: Dashboard;
  canSaveTemplate: boolean;
  canDelete: boolean;
}) {
  const template = useSaveAsTemplate({
    workspaceId,
    subject: { kind: "dashboard", dashboard: spec },
    defaultName: title,
  });
  const remove = useDeleteDashboard(dashboardId, title);

  return (
    <div className="relative flex flex-col items-end">
      <Menu
        label="More actions"
        className="h-8 w-8"
        trigger={
          remove.deleting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <MoreHorizontal className="h-4 w-4" />
          )
        }
      >
        {/*
          A plain link, not a fetch: the route answers with a
          `Content-Disposition`, so the browser saves the file itself.
        */}
        <MenuItem href={`/api/dashboards/${dashboardId}/export`} download>
          <Download className="h-4 w-4" /> Export
        </MenuItem>
        {canSaveTemplate && (
          <MenuItem onClick={template.openDialog}>
            {template.saved ? (
              <Check className="h-4 w-4" />
            ) : (
              <BookmarkPlus className="h-4 w-4" />
            )}
            {template.saved ? "Saved as template" : "Save as template"}
          </MenuItem>
        )}
        {canDelete && (
          <>
            <MenuSeparator />
            <MenuItem
              danger
              onClick={() => void remove.onDelete()}
              disabled={remove.deleting}
            >
              <Trash2 className="h-4 w-4" /> Delete
            </MenuItem>
          </>
        )}
      </Menu>
      {/* Outside the menu: its popup unmounts on close, and the dialog would go with it. */}
      {template.dialog}
      {remove.error && (
        <ErrorDisplay
          error={remove.error}
          onRetry={() => void remove.onDelete()}
          retryLabel="Try again"
          disabled={remove.deleting}
          className="absolute top-full right-0 z-10 mt-1 w-max max-w-xs"
        />
      )}
    </div>
  );
}

/**
 * Deletes a dashboard via DELETE /api/dashboards/[id] (soft delete; the server
 * re-checks `dashboard:delete`). Confirms first, returns to the list on
 * success, and leaves `error` set on failure for the caller to show.
 */
export function useDeleteDashboard(
  dashboardId: string,
  title: string,
): { onDelete: () => Promise<void>; deleting: boolean; error: ApiError | null } {
  const router = useRouter();
  const [deleting, setDeleting] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  async function onDelete() {
    if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return;
    setDeleting(true);
    setError(null);
    const res = await fetch(`/api/dashboards/${dashboardId}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      setError(await readApiError(res));
      setDeleting(false);
      return;
    }
    router.push("/dashboards");
    router.refresh();
  }

  return { onDelete, deleting, error };
}
