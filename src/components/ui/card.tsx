import type * as React from "react";
import { cn } from "@/lib/utils";

// `ComponentPropsWithRef` rather than `HTMLAttributes`: a panel that can go
// fullscreen needs to focus its own card, and in React 19 `ref` is an ordinary
// prop — so the primitive simply passes it through.
export function Card({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return (
    <div
      className={cn("border border-border bg-surface shadow-sm", className)}
      {...props}
    />
  );
}

export function CardHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex items-center justify-between px-4 py-3", className)}
      {...props}
    />
  );
}

/**
 * A card's heading. `h2` by default because a card sits directly under the
 * page's `h1` (`PageHeader`) almost everywhere, and a skipped level breaks a
 * screen reader's outline of the page (#77); `as` for a card nested deeper.
 */
export function CardTitle({
  className,
  as: Heading = "h2",
  ...props
}: React.HTMLAttributes<HTMLHeadingElement> & { as?: "h2" | "h3" | "h4" }) {
  return <Heading className={cn("text-sm font-semibold", className)} {...props} />;
}

export function CardContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-4 py-3", className)} {...props} />;
}
