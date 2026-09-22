"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Save } from "lucide-react";
import type { Panel, TimeRange } from "@/lib/ir";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Dialog } from "@/components/ui/dialog";
import { ErrorDisplay } from "@/components/ui/error-display";
import type { ApiError } from "@/lib/errors";
import {
  type DashboardOption,
  listEditableDashboards,
  saveToExistingDashboard,
  saveToNewDashboard,
} from "@/lib/explore-save";

/** The picker's sentinel for "don't append — create one". */
const NEW_DASHBOARD = "__new__";

export interface SavedPanel {
  dashboardId: string;
  panelId: string;
}

/**
 * Pick where an Explore result should land.
 *
 * The picker is scoped to the source's workspace and to dashboards the caller
 * can update, both enforced by the list route — a dashboard in another
 * workspace could not hold this panel anyway, since a spec's workspace is
 * derived from its panels' sources and must be single-valued.
 */
export function SavePanelDialog({
  open,
  onOpenChange,
  panel,
  workspaceId,
  defaultTimeRange,
  defaultRefreshIntervalMs,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  panel: Panel;
  workspaceId: string;
  defaultTimeRange: TimeRange;
  defaultRefreshIntervalMs: number;
  onSaved: (saved: SavedPanel) => void;
}) {
  const router = useRouter();
  const [dashboards, setDashboards] = React.useState<DashboardOption[] | null>(null);
  const [target, setTarget] = React.useState<string>(NEW_DASHBOARD);
  const [title, setTitle] = React.useState(panel.title);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  // Load the picker each time it opens: another tab may have added a dashboard
  // since, and a stale list here offers a save that cannot happen.
  React.useEffect(() => {
    if (!open) return;
    let live = true;
    setDashboards(null);
    setError(null);
    setTitle(panel.title);
    void listEditableDashboards(workspaceId).then((outcome) => {
      if (!live) return;
      if (!outcome.ok) {
        setDashboards([]);
        setError(outcome.error);
        return;
      }
      setDashboards(outcome.dashboards);
      setTarget(outcome.dashboards[0]?.id ?? NEW_DASHBOARD);
    });
    return () => {
      live = false;
    };
  }, [open, workspaceId, panel.title]);

  const creating = target === NEW_DASHBOARD;

  async function save() {
    setSaving(true);
    setError(null);
    const outcome = creating
      ? await saveToNewDashboard({
          title,
          panel,
          timeRange: defaultTimeRange,
          refreshIntervalMs: defaultRefreshIntervalMs,
        })
      : await saveToExistingDashboard(target, panel);
    setSaving(false);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    onSaved({ dashboardId: outcome.dashboardId, panelId: outcome.panelId });
    onOpenChange(false);
    // A new dashboard opens in the editor with its one panel selected; an
    // existing one is left alone — Explore keeps the result on screen and
    // offers a link instead of navigating away from the question.
    if (creating) {
      router.push(
        `/dashboards/${outcome.dashboardId}/edit?panel=${encodeURIComponent(outcome.panelId)}`,
      );
    }
  }

  const options = [
    ...(dashboards ?? []).map((d) => ({ value: d.id, label: d.title })),
    { value: NEW_DASHBOARD, label: "New dashboard…" },
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Save as panel"
      className="max-w-lg"
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Add &ldquo;{panel.title}&rdquo; to a dashboard in{" "}
          <span className="text-foreground">{workspaceId}</span>.
        </p>

        {dashboards === null ? (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading dashboards…
          </div>
        ) : (
          <div>
            <Label htmlFor="save-target">Dashboard</Label>
            <Select
              id="save-target"
              className="w-full"
              value={target}
              onValueChange={setTarget}
              options={options}
            />
          </div>
        )}

        {creating && dashboards !== null && (
          <div>
            <Label htmlFor="save-title">New dashboard title</Label>
            <Input
              id="save-title"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
        )}

        {error && (
          <ErrorDisplay
            error={error}
            onRetry={save}
            retryLabel="Try again"
            disabled={saving}
          />
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={saving || dashboards === null || (creating && !title.trim())}
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {creating ? "Create dashboard" : "Add panel"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
