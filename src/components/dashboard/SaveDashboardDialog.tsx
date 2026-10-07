"use client";

import * as React from "react";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { ErrorDisplay } from "@/components/ui/error-display";
import type { ApiError } from "@/lib/errors";

/** `Dashboard.title` is `z.string().min(1).max(200)`; the box stops at the same place. */
const TITLE_MAX = 200;

/**
 * The finish of `/dashboards/new` (#356): confirm or change the title, see
 * where it is going, save.
 *
 * The workspace is shown, not chosen: a dashboard belongs to the workspace of
 * the source it was generated against, and the server decides that from the
 * spec. Naming it here is so the author is not surprised by where it lands.
 */
export function SaveDashboardDialog({
  open,
  onOpenChange,
  defaultTitle,
  workspaceId,
  saving,
  error,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The generated title, offered as the starting point. */
  defaultTitle: string;
  workspaceId: string;
  saving: boolean;
  error: ApiError | null;
  onSave: (title: string) => void;
}) {
  const [title, setTitle] = React.useState(defaultTitle);
  // Re-seeded on every open, so a later turn's title is what is offered.
  React.useEffect(() => {
    if (open) setTitle(defaultTitle);
  }, [open, defaultTitle]);
  const trimmed = title.trim();

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Save dashboard"
      className="max-w-md"
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed && !saving) onSave(trimmed);
        }}
      >
        <div>
          <Label htmlFor="save-title">Title</Label>
          <Input
            id="save-title"
            value={title}
            maxLength={TITLE_MAX}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </div>
        <p className="text-sm text-muted">
          Saves to the <span className="text-foreground">{workspaceId}</span> workspace,
          the one its data source belongs to, as version 1.
        </p>
        {error && <ErrorDisplay error={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={!trimmed || saving}>
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save dashboard
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
