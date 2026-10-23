import type * as React from "react";
import { cn } from "@/lib/utils";

/*
 * The Holotable mark (#667): a table top seen from above at an angle, with
 * what it projects rising from the middle. Drawn on a 16-unit pixel grid with
 * square corners, so it is pixel-exact at 16px and at any multiple of it
 * (`size-4`, `size-8`); between multiples the pixels come out uneven. One
 * color, `currentColor`, so it takes whatever text color it sits in, forced
 * colors included. `src/app/icon.svg`, the docs site's logo and favicon and
 * the demo's starting page carry the same path.
 */
export const LOGO_PATH =
  "M7 4h2v1H7zM5 5h6v1H5zM3 6h4v1H3zM9 6h4v1H9zM1 7h4v1H1zM11 7h4v1h-4zM3 8h4v1H3zM9 8h4v1H9zM1 9h2v1H1zM5 9h6v1H5zM13 9h2v1h-2zM3 10h2v1H3zM7 10h2v1H7zM11 10h2v1h-2zM5 11h2v1H5zM9 11h2v1H9zM7 12h2v1H7z";

/*
 * Under forced colors the system recolors text but leaves an SVG's own
 * `color` alone, so a mark in `text-primary` would keep the theme's blue on a
 * system background. It inherits the system color of the text around it (a
 * link's, in the nav bar) instead. Last, so it outranks a caller's color.
 */
const FORCED = "forced-colors:text-inherit";

export interface LogoProps
  extends Omit<React.ComponentPropsWithoutRef<"svg">, "children"> {
  /**
   * The accessible name when the mark stands alone. Without one it is
   * decoration, hidden from assistive technology, as it is beside the visible
   * "Holotable" of the wordmark.
   */
  label?: string;
}

/** The mark alone. 32px by default; size it in multiples of 16. */
export function Logo({ label, className, ...props }: LogoProps) {
  const shared = {
    xmlns: "http://www.w3.org/2000/svg",
    viewBox: "0 0 16 16",
    shapeRendering: "crispEdges",
    className: cn("size-8 shrink-0", className, FORCED),
    ...props,
  };
  const path = <path fill="currentColor" d={LOGO_PATH} />;
  if (label) {
    return (
      <svg role="img" aria-label={label} {...shared}>
        <title>{label}</title>
        {path}
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" focusable="false" {...shared}>
      {path}
    </svg>
  );
}

/** The mark in the primary color beside "Holotable": the nav bar's brand. */
export function Wordmark({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"span">) {
  return (
    <span className={cn("flex items-center gap-2 font-semibold", className)} {...props}>
      <Logo className="text-primary" />
      Holotable
    </span>
  );
}
