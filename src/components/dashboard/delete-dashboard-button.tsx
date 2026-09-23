"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2 } from "lucide-react";
import { Button, ButtonLabel } from "@/components/ui/button";
import { ErrorDisplay } from "@/components/ui/error-display";
import { type ApiError, readApiError } from "@/lib/errors";

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

  return (
    <div className="relative flex flex-col items-end">
      <Button
        variant="ghost"
        size="sm"
        collapse
        title="Delete"
        onClick={onDelete}
        disabled={deleting}
        className="text-muted hover:bg-danger/10 hover:text-danger"
      >
        {deleting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Trash2 className="h-4 w-4" />
        )}
        <ButtonLabel>Delete</ButtonLabel>
      </Button>
      {error && (
        <ErrorDisplay
          error={error}
          onRetry={onDelete}
          retryLabel="Try again"
          disabled={deleting}
          className="absolute top-full z-10 mt-1 w-max max-w-xs"
        />
      )}
    </div>
  );
}
