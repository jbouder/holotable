import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A placeholder block for content that has been asked for and has not arrived.
 *
 * The shimmer lives in `globals.css` behind `prefers-reduced-motion: no-preference`,
 * so a reader who asked for less motion gets a static muted block and no call
 * site has to remember to check (#72). Always `aria-hidden`: a skeleton is the
 * shape of an answer, not an answer, and the surface around it is what says
 * "loading" out loud.
 */
export function Skeleton({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return <div aria-hidden className={cn("skeleton rounded-md", className)} {...props} />;
}
