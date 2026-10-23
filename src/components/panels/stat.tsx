import { DatumLinksBody } from "@/components/dashboard/DatumLinks";
import type { PanelBodyProps } from "@/components/panels/types";
import { datumOf } from "@/lib/drilldown-datum";
import { fillCss, tokenCss } from "@/lib/panels/colors";
import { statReading } from "@/lib/panel-reading";

/**
 * One formatted number: the named value column, or the last row's first
 * numeric column that is not the time field. Thresholds color it, and a
 * sparkline of the column can sit behind it (#115). Both take the token's
 * color in the page's scheme (#502).
 */
export function StatView({ panel, data }: PanelBodyProps) {
  const reading = statReading(panel, data);
  // A token is a CSS variable (#502), the scheme's own color: the number
  // takes it as text, held to AA, and the sparkline as a fill, which in a
  // light scheme is a brighter amber than text can be (#641).
  const color = reading.color ? fillCss(reading.color) : undefined;
  const text = reading.color ? tokenCss(reading.color) : undefined;
  // The whole number is the datum (#373): with a datum link, the body is one control.
  return (
    <DatumLinksBody datum={datumOf(panel, data, {})} label={panel.title}>
      <StatBody reading={reading} color={color} text={text} />
    </DatumLinksBody>
  );
}

function StatBody({
  reading,
  color,
  text,
}: {
  reading: ReturnType<typeof statReading>;
  /** The sparkline's color: the token as a fill, as a CSS color. */
  color?: string;
  /** The number's color: the token as text, or none. */
  text?: string;
}) {
  return (
    <div className="relative flex h-full items-center justify-center">
      {reading.sparkPoints && <Sparkline points={reading.sparkPoints} color={color} />}
      {/* Shrinks with the viewport: a 4xl number is most of a phone panel. */}
      <span
        className="relative text-3xl font-semibold tabular-nums sm:text-4xl"
        style={text ? { color: text } : undefined}
      >
        {reading.text}
      </span>
    </div>
  );
}

/**
 * The value's history, faint, across the bottom of the panel. Drawn in the
 * threshold's chart color, so a threshold that turns the number turns it too.
 * Its points are joined as the panel's curve says (`sparklinePoints`).
 */
function Sparkline({ points, color }: { points: string; color?: string }) {
  return (
    <svg
      viewBox="0 -4 100 108"
      preserveAspectRatio="none"
      aria-hidden
      className="absolute inset-x-0 bottom-0 h-1/2 w-full text-primary opacity-(--chart-faint)"
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
