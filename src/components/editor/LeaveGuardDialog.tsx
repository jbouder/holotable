"use client";

import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

/**
 * The prompt shown when someone leaves the editor with unsaved changes (#117).
 *
 * Three answers, because two is not enough: Cancel used to discard a session's
 * work silently, and an unconditional "are you sure?" only moves the loss one
 * click away. Save is offered in the same breath as Discard so the safe answer
 * is the easy one.
 */
export function LeaveGuardDialog({
  open,
  saving,
  onSave,
  onDiscard,
  onCancel,
}: {
  open: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title="Unsaved changes"
      className="max-w-md"
    >
      <p className="text-sm text-muted">
        This dashboard has changes that are not in a saved version yet. Leaving now
        discards them.
      </p>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Keep editing
        </Button>
        <Button variant="danger" onClick={onDiscard} disabled={saving}>
          Discard changes
        </Button>
        <Button onClick={onSave} disabled={saving}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save and leave
        </Button>
      </div>
    </Dialog>
  );
}
