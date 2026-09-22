"use client";

import { Dialog } from "@/components/ui/dialog";
import { formatShortcut, type Shortcut, useIsMac } from "@/lib/editor/use-shortcuts";

/**
 * The `?` overlay (#121).
 *
 * A shortcut nobody can find is not a shortcut, and the bindings are declared
 * in one list in the editor — so this renders that same list rather than a
 * hand-maintained copy that would drift the first time a binding changed.
 */
export function ShortcutsDialog({
  shortcuts,
  open,
  onOpenChange,
}: {
  shortcuts: Shortcut[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mac = useIsMac();
  const groups = new Map<string, Shortcut[]>();
  for (const shortcut of shortcuts) {
    const list = groups.get(shortcut.group) ?? [];
    list.push(shortcut);
    groups.set(shortcut.group, list);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Keyboard shortcuts"
      className="max-w-lg"
    >
      <div className="space-y-5">
        {[...groups].map(([group, list]) => (
          <section key={group}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              {group}
            </h3>
            <dl className="space-y-1.5">
              {list.map((shortcut) => (
                <div
                  key={shortcut.id}
                  className="flex items-center justify-between gap-4"
                >
                  <dt className="text-sm">{shortcut.description}</dt>
                  <dd>
                    <kbd className="rounded border border-border bg-surface-2 px-2 py-0.5 font-mono text-xs">
                      {formatShortcut(shortcut, mac)}
                    </kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <p className="text-xs text-muted">
          Every shortcut here has a button too &mdash; nothing is reachable by keyboard
          only.
        </p>
      </div>
    </Dialog>
  );
}
