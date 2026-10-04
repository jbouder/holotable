import type { PanelBodyProps } from "@/components/panels/types";
import { cn } from "@/lib/utils";

/**
 * The first column is sticky and the table scrolls sideways under it, so a
 * narrow screen keeps the label of the row it is reading (#78). `w-max` rather
 * than `w-full`: the table is allowed to be wider than the panel — that is
 * what gives it something to scroll — and stretches to fill when it is not.
 */
export function TableView({ data }: PanelBodyProps) {
  return (
    <div className="max-h-full overflow-auto">
      <table className="w-max min-w-full text-left text-sm">
        <thead className="sticky top-0 z-10 bg-surface-2 text-muted">
          <tr>
            {data.columns.map((c, i) => (
              <th
                key={c}
                className={cn(
                  "px-2 py-1 font-medium",
                  i === 0 && "sticky left-0 z-10 bg-surface-2",
                )}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.slice(-100).map((r, i) => (
            // Query result rows carry no stable identity, and the table is
            // render-only — nothing is reordered, edited or keyed off state.
            // biome-ignore lint/suspicious/noArrayIndexKey: result rows have no id
            <tr key={i} className="border-t border-border">
              {data.columns.map((c, col) => (
                <td
                  key={c}
                  className={cn(
                    "px-2 py-1 tabular-nums",
                    col === 0 && "sticky left-0 bg-surface",
                  )}
                >
                  {String(r[c] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
