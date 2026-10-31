import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A table that scrolls sideways inside its own box when it is wider than the
 * page (WCAG 1.4.10, #683). `relative`, so the box clips what is positioned
 * inside it, a button's `sr-only` name among them, which would otherwise reach
 * past the box and make the whole page scroll on a phone.
 *
 * A keyboard scrolls the box by tabbing to the controls in its rows. A table
 * with none, a read-only list, passes `label`: the box becomes a named region
 * that takes focus itself, so the arrow keys can scroll it (2.1.1).
 */
export function Table({
  className,
  label,
  ...props
}: React.TableHTMLAttributes<HTMLTableElement> & { label?: string }) {
  return (
    <div
      {...(label
        ? {
            role: "region",
            "aria-label": label,
            // Focusable, so the arrow keys scroll it (WCAG 2.1.1).
            tabIndex: 0,
          }
        : {})}
      className="relative overflow-x-auto rounded-lg border border-border bg-surface focus-visible:outline-2 focus-visible:outline-ring"
    >
      <table className={cn("w-full text-sm", className)} {...props} />
    </div>
  );
}

export function TableHead({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead className={cn("border-b border-border bg-surface-2", className)} {...props} />
  );
}

export function TableBody({ className, ...props }: React.ComponentPropsWithRef<"tbody">) {
  return <tbody className={className} {...props} />;
}

export function TableRow({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        "border-b border-border last:border-b-0 hover:bg-surface-2/50",
        className,
      )}
      {...props}
    />
  );
}

export function TableHeader({
  className,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        "whitespace-nowrap px-4 py-3 text-left text-xs font-medium text-muted",
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({
  className,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-4 py-3 align-middle", className)} {...props} />;
}
