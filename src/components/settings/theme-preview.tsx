import { buttonClassName } from "@/components/ui/button-styles";
import type { Palette } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * A theme, shown by drawing a little of the product in it (#507).
 *
 * The same tokens and primitives the app uses, under the option's own
 * `data-palette` and `data-theme`: a header strip, a stat with a sparkline,
 * a line chart on its grid, a badge in each status, a primary button, a
 * muted caption and a table row. Static markup with no data and no ECharts:
 * a swatch that reads. The card around it is hidden from assistive
 * technology, and its label and description carry the meaning.
 */
export function ThemePreview({
  palette,
  scheme,
}: {
  palette: Palette;
  /** `system` draws light and dark side by side. */
  scheme: "light" | "dark" | "system";
}) {
  return (
    <span className="flex w-full overflow-hidden rounded-lg border border-border">
      {scheme === "system" ? (
        <>
          <Scene palette={palette} scheme="light" compact />
          <Scene palette={palette} scheme="dark" compact />
        </>
      ) : (
        <Scene palette={palette} scheme={scheme} />
      )}
    </span>
  );
}

/** Three series over a grid, in the chart tokens. */
const LINES = [
  { stroke: "stroke-chart-1", d: "M0 26 L12 22 L24 24 L36 14 L48 17 L60 9" },
  { stroke: "stroke-chart-2", d: "M0 32 L12 30 L24 27 L36 28 L48 22 L60 21" },
  { stroke: "stroke-chart-3", d: "M0 36 L12 35 L24 33 L36 34 L48 31 L60 29" },
];

/**
 * One scheme of the preview. `compact` (each half of a System card) leaves out
 * the stat, so the chart and the badges keep their room.
 */
function Scene({
  palette,
  scheme,
  compact = false,
}: {
  palette: Palette;
  scheme: "light" | "dark";
  compact?: boolean;
}) {
  return (
    <span
      data-palette={palette}
      data-theme={scheme}
      // A picture, hidden from assistive technology: its text is drawn at a
      // miniature's size, not read (#507).
      className="flex min-w-0 flex-1 flex-col gap-1.5 bg-background p-2 text-[9px] leading-tight text-foreground"
    >
      {/* The page header. */}
      <span className="flex items-center justify-between gap-1">
        <span className="truncate font-semibold">Service health</span>
        <span
          className={cn(
            buttonClassName({ size: "sm" }),
            "h-auto px-1.5 py-0.5 text-[8px]",
          )}
        >
          Edit
        </span>
      </span>
      <span
        className={cn(
          "grid h-16 gap-1.5",
          compact ? "grid-cols-1" : "grid-cols-[2fr_3fr]",
        )}
      >
        {/* A stat with its sparkline. */}
        <span
          className={cn(
            "min-w-0 flex-col justify-between rounded-lg border border-border bg-surface p-1.5",
            compact ? "hidden" : "flex",
          )}
        >
          <span className="text-muted">p95</span>
          <span className="whitespace-nowrap text-sm font-semibold tabular-nums">
            212 ms
          </span>
          <svg
            aria-hidden="true"
            viewBox="0 0 60 14"
            className="h-3 w-full"
            preserveAspectRatio="none"
          >
            <path
              d="M0 10 L10 8 L20 9 L30 5 L40 7 L50 3 L60 4"
              className="fill-none stroke-chart-1"
              strokeWidth={1.5}
            />
          </svg>
        </span>
        {/* A line chart on its grid. */}
        <span className="flex min-h-0 min-w-0 flex-col rounded-lg border border-border bg-surface p-1.5">
          <svg
            aria-hidden="true"
            viewBox="0 0 60 40"
            className="h-full w-full"
            preserveAspectRatio="none"
          >
            {[10, 20, 30].map((y) => (
              <line key={y} x1={0} x2={60} y1={y} y2={y} className="stroke-chart-grid" />
            ))}
            {LINES.map((l) => (
              <path
                key={l.d}
                d={l.d}
                className={cn("fill-none", l.stroke)}
                strokeWidth={1.5}
              />
            ))}
          </svg>
        </span>
      </span>
      {/* A badge in each status, as the app draws them. */}
      <span className="flex flex-wrap gap-1">
        {(
          [
            ["Live", "bg-tint-success/(--tint-20) text-success"],
            ["Slow", "bg-tint-warning/(--tint-20) text-warning"],
            ["Down", "bg-tint-danger/(--tint-20) text-danger"],
          ] as const
        ).map(([word, tint]) => (
          <span key={word} className={cn("tinted rounded-lg px-1 font-medium", tint)}>
            {word}
          </span>
        ))}
      </span>
      {/* A table row and a caption. */}
      <span className="flex justify-between border-t border-border pt-1">
        <span>/checkout</span>
        <span className="tabular-nums text-muted">1.2k req</span>
      </span>
    </span>
  );
}
