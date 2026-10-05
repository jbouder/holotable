import type { PanelBodyProps } from "@/components/panels/types";
import { tableView } from "@/lib/panel-reading";
import { cn } from "@/lib/utils";

const ALIGN = { left: "text-left", center: "text-center", right: "text-right" } as const;

/**
 * The first column is sticky and the table scrolls sideways under it, so a
 * narrow screen keeps the label of the row it is reading (#78). `w-max` rather
 * than `w-full`: the table is allowed to be wider than the panel — that is
 * what gives it something to scroll — and stretches to fill when it is not.
 *
 * Which columns, in what order, under what header and written how, and the
 * rows' order, are the panel's options (#115); without any it is the result
 * as it came.
 */
export function TableView({ panel, data }: PanelBodyProps) {
  const { columns, rows } = tableView(panel, data);
  return (
    // Focusable, so a keyboard can scroll a table that overflows its panel;
    // named, so what took focus is announced (#77).
    <section
      aria-label={`${panel.title}, table`}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container must be focusable to scroll by keyboard (WCAG 2.1.1)
      tabIndex={0}
      className="max-h-full overflow-auto focus-visible:outline-2 focus-visible:outline-primary"
    >
      <table className="w-max min-w-full text-left text-sm">
        <thead className="sticky top-0 z-10 bg-surface-2 text-muted">
          <tr>
            {columns.map((c, i) => (
              <th
                key={c.name}
                className={cn(
                  "px-2 py-1 font-medium",
                  c.align && ALIGN[c.align],
                  i === 0 && "sticky left-0 z-10 bg-surface-2",
                )}
                style={c.width ? { width: c.width, minWidth: c.width } : undefined}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            // Query result rows carry no stable identity, and the table is
            // render-only — nothing is reordered, edited or keyed off state.
            // biome-ignore lint/suspicious/noArrayIndexKey: result rows have no id
            <tr key={i} className="border-t border-border">
              {columns.map((c, col) => (
                <td
                  key={c.name}
                  className={cn(
                    "px-2 py-1 tabular-nums",
                    c.align && ALIGN[c.align],
                    col === 0 && "sticky left-0 bg-surface",
                  )}
                >
                  {c.text(r[c.name])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
