import { DatumLinksBody } from "@/components/dashboard/DatumLinks";
import { TileScroller } from "@/components/panels/tile-scroller";
import type { PanelBodyProps } from "@/components/panels/types";
import { STATUS_TILE_TINT } from "@/lib/color/contrast";
import { cn } from "@/lib/utils";
import { tokenCss } from "@/lib/panels/colors";
import { StatusGridOptions } from "@/lib/panels/kinds/status-grid";
import { readOptions } from "@/lib/panels/presentation";
import { type StatusTile, statusGrid } from "@/lib/panel-reading";

/**
 * One tile per entity, its latest value and its color (#404). A tile is a
 * datum (#373): with a datum link it is one control, named by its label,
 * value and state, so a fleet's first click is a drilldown.
 *
 * The color is a tint and a stripe behind text that is all `foreground`, not
 * the text's own color: `CONTRAST_PAIRS` holds every spec color's tile to AA
 * in both themes, and `muted` would not pass on all of them. The value and
 * state are always written, so color is never the only way to tell two tiles
 * apart.
 */
export function StatusGridView({ panel, data }: PanelBodyProps) {
  const { tiles, overflow } = statusGrid(panel, data);
  const { columns } = readOptions(StatusGridOptions, panel.options);
  return (
    // Scrolls when the tiles do not fit, and says how many are out of view (#645).
    <TileScroller label={`${panel.title}, status grid`}>
      <ul
        className="grid gap-1.5"
        style={{
          gridTemplateColumns:
            columns !== undefined
              ? `repeat(${columns}, minmax(0, 1fr))`
              : "repeat(auto-fill, minmax(7rem, 1fr))",
        }}
      >
        {tiles.map((tile) => (
          <li key={tile.label} data-tile className="min-w-0">
            <DatumLinksBody
              datum={{ row: tile.row, series: tile.label }}
              label={tileName(tile)}
            >
              <Tile tile={tile} />
            </DatumLinksBody>
          </li>
        ))}
      </ul>
      {overflow > 0 && (
        <p className="mt-1.5 text-xs text-muted">
          {overflow} more not shown. Narrow the query to see them.
        </p>
      )}
    </TileScroller>
  );
}

/** What a tile says to a screen reader, and as a link's name. */
function tileName(tile: StatusTile): string {
  return [tile.label, tile.text, tile.state].filter(Boolean).join(", ");
}

function Tile({ tile }: { tile: StatusTile }) {
  const hex = tile.color ? tokenCss(tile.color) : undefined;
  // The text of a colored tile takes the tint ink. It goes on the text, not
  // the tile, whose fill names the status variable `.tinted` swaps.
  const ink = hex ? "tinted" : undefined;
  return (
    <div
      className="flex h-full flex-col gap-0.5 rounded-lg border border-l-4 border-border bg-surface-2 px-2 py-1.5"
      style={
        hex
          ? {
              borderLeftColor: hex,
              // Composited in sRGB, which is what `CONTRAST_PAIRS` measures, at
              // the theme's tint alpha: a solid fill in high contrast (#506).
              backgroundColor: `color-mix(in srgb, ${hex} var(--tint-${STATUS_TILE_TINT * 100}), var(--surface-2))`,
            }
          : undefined
      }
    >
      {/* The spaces between the lines are not drawn (they are flex items) but
          keep the words apart in the text a checker reads off the link, which
          must appear in its name (WCAG 2.5.3, Label in Name). */}
      <span className={cn("truncate text-xs text-foreground", ink)} title={tile.label}>
        {tile.label}
      </span>{" "}
      {tile.text && (
        <span
          className={cn(
            "truncate text-base font-semibold tabular-nums text-foreground",
            ink,
          )}
        >
          {tile.text}
        </span>
      )}{" "}
      {tile.state && (
        <span className={cn("truncate text-xs font-medium text-foreground", ink)}>
          {tile.state}
        </span>
      )}
    </div>
  );
}
