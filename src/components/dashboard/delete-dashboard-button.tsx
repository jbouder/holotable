"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Deletes a dashboard via DELETE /api/dashboards/[id] (soft delete, server
 * re-checks `dashboard:delete`), then returns to the list. Rendered only when
 * the caller has already been authorized server-side.
 */
export function DeleteDashboardButton({
  dashboardId,
  title,
}: {
  dashboardId: string;
  title: string;
}) {
  const router = useRouter();
  const [deleting, setDeleting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onDelete() {
    if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return;
    setDeleting(true);
    setError(null);
    const res = await fetch(`/api/dashboards/${dashboardId}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "delete failed");
      setDeleting(false);
      return;
    }
    router.push("/dashboards");
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="danger"
        size="sm"
        onClick={onDelete}
        disabled={deleting}
      >
        {deleting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Trash2 className="h-4 w-4" />
        )}
        Delete
      </Button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
