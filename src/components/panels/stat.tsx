import { formatValue } from "@/lib/format";
import type { PanelBodyProps } from "@/components/panels/types";

/**
 * The last row's first numeric column that is not the time field, as one
 * formatted number.
 */
export function StatView({ panel, data }: PanelBodyProps) {
  const last = data.rows[data.rows.length - 1];
  const valueKey =
    data.columns.find(
      (c) => c !== panel.query.timeField && typeof last?.[c] === "number",
    ) ?? data.columns[data.columns.length - 1];
  const value = last?.[valueKey];
  return (
    <div className="flex h-full items-center justify-center">
      {/* Shrinks with the viewport: a 4xl number is most of a phone panel. */}
      <span className="text-3xl font-semibold tabular-nums sm:text-4xl">
        {value === undefined ? "—" : formatValue(value, panel.format)}
      </span>
    </div>
  );
}
