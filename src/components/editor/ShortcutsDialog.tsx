"use client";

import Link from "next/link";
import { Dialog } from "@/components/ui/dialog";
import { ShortcutList } from "@/components/shortcut-list";
import { EDITOR_SHORTCUTS } from "@/lib/shortcuts";

/**
 * The `?` overlay (#121).
 *
 * A shortcut nobody can find is not a shortcut. The list is the editor's
 * entries in the registry (#217), the same ones the editor binds and the
 * settings page shows, so the three cannot disagree.
 */
export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Keyboard shortcuts"
      className="max-w-lg"
    >
      <div className="space-y-5">
        <ShortcutList shortcuts={EDITOR_SHORTCUTS} />
        <p className="text-xs text-muted">
          Every shortcut here has a button too &mdash; nothing is reachable by keyboard
          only.{" "}
          <Link href="/settings/shortcuts" className="text-primary hover:underline">
            All shortcuts
          </Link>
        </p>
      </div>
    </Dialog>
  );
}
