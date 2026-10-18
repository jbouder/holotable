"use client";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { UploadAvailability } from "@/lib/sources/types";
import { DuckDbUploadPicker } from "./duckdb-upload-picker";

/**
 * Add files to a source made by uploading (#604): the Add-source form's
 * picker, aimed at the source, with the same progress, Cancel, stages and
 * refusals. Stored files are not tables yet, so a finished upload hands off
 * to the catalog refresh, where the new tables are reviewed and applied;
 * nothing here edits the allowlist.
 */
export function AddFilesDialog({
  source,
  limits,
  onClose,
  onUploaded,
}: {
  /** The upload source to add to; null keeps the dialog closed. */
  source: { id: string; name: string } | null;
  limits: UploadAvailability | null;
  onClose: () => void;
  /** The files are stored: open the refresh for the source. */
  onUploaded: (sourceId: string) => void;
}) {
  return (
    <Dialog
      open={source !== null && limits !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={source ? `Add files to ${source.name}` : "Add files"}
    >
      {source && limits && (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            Each file becomes a new table in this source, beside the ones it has. Once
            they are stored, review the new tables and apply them to the catalog.
          </p>
          <DuckDbUploadPicker
            key={source.id}
            target={{ sourceId: source.id }}
            limits={limits}
            finalStage="Review"
            discovering={false}
            discovered={false}
            onUploaded={() => onUploaded(source.id)}
            onReset={() => {}}
          />
          <div className="flex justify-end">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
