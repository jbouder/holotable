"use client";

import { formatShortcut, type Shortcut, useIsMac } from "@/lib/editor/use-shortcuts";

/**
 * Shortcuts grouped under their `group` headings, each with its chord for
 * this platform: `⌘` on macOS, `Ctrl` elsewhere, resolved after mount so the
 * server render does not guess. Shared by the editor's `?` overlay and the
 * `/settings/shortcuts` page (#217).
 */
export function ShortcutList({
  shortcuts,
  headingLevel = "h3",
}: {
  shortcuts: readonly Shortcut[];
  headingLevel?: "h3" | "h4";
}) {
  const mac = useIsMac();
  const groups = new Map<string, Shortcut[]>();
  for (const shortcut of shortcuts) {
    const list = groups.get(shortcut.group) ?? [];
    list.push(shortcut);
    groups.set(shortcut.group, list);
  }
  const Heading = headingLevel;

  return (
    <div className="space-y-5">
      {[...groups].map(([group, list]) => (
        <section key={group}>
          <Heading className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
            {group}
          </Heading>
          <dl className="space-y-1.5">
            {list.map((shortcut) => (
              <div key={shortcut.id} className="flex items-center justify-between gap-4">
                <dt className="text-sm">{shortcut.description}</dt>
                <dd className="shrink-0">
                  <kbd className="border border-border bg-surface-2 px-2 py-0.5 font-mono text-xs">
                    {formatShortcut(shortcut, mac)}
                  </kbd>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
