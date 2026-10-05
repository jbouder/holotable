import type { PanelBodyProps } from "@/components/panels/types";
import { tokenHex } from "@/lib/panels/colors";
import { statReading } from "@/lib/panel-reading";

/**
 * One formatted number: the named value column, or the last row's first
 * numeric column that is not the time field. Thresholds color it, and a
 * sparkline of the column can sit behind it (#115).
 */
export function StatView({ panel, data }: PanelBodyProps) {
  const reading = statReading(panel, data);
  const color = reading.color ? tokenHex(reading.color) : undefined;
  return (
    <div className="relative flex h-full items-center justify-center">
      {reading.spark.length > 1 && <Sparkline values={reading.spark} color={color} />}
      {/* Shrinks with the viewport: a 4xl number is most of a phone panel. */}
      <span
        className="relative text-3xl font-semibold tabular-nums sm:text-4xl"
        style={color ? { color } : undefined}
      >
        {reading.text}
      </span>
    </div>
  );
}

/**
 * The value's history, faint, across the bottom of the panel. Drawn in the
 * number's own color, so a threshold that turns one turns both.
 */
function Sparkline({ values, color }: { values: number[]; color?: string }) {
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const points = values
    .map((v, i) => `${(i / (values.length - 1)) * 100},${100 - ((v - min) / span) * 100}`)
    .join(" ");
  return (
    <svg
      viewBox="0 -4 100 108"
      preserveAspectRatio="none"
      aria-hidden
      className="absolute inset-x-0 bottom-0 h-1/2 w-full text-primary opacity-30"
      style={color ? { color } : undefined}
    >
      <polygon points={`0,104 ${points} 100,104`} fill="currentColor" opacity={0.25} />
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
