"use client";

import * as React from "react";
import { Button as BaseButton } from "@base-ui/react/button";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "icon";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50",
  secondary:
    "bg-surface-2 text-foreground hover:bg-surface border border-border disabled:opacity-50",
  ghost: "bg-transparent text-foreground hover:bg-surface-2 disabled:opacity-50",
  danger: "bg-danger text-primary-foreground hover:opacity-90 disabled:opacity-50",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-sm",
  icon: "h-9 w-9 p-0",
};

export interface ButtonProps extends React.ComponentPropsWithoutRef<typeof BaseButton> {
  variant?: Variant;
  size?: Size;
  /**
   * Below `sm`, square the button off to its icon. Pair it with a
   * {@link ButtonLabel} for the text and a `title` for the tooltip, so a
   * toolbar row shrinks instead of overflowing on a phone.
   */
  collapse?: boolean;
}

export const Button = React.forwardRef<HTMLElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", collapse = false, ...props }, ref) => (
    <BaseButton
      ref={ref}
      className={cn(
        // `tap-target` is the coarse-pointer minimum (#78): on a touch screen
        // every button grows to 44px in both directions, and on a mouse-driven
        // screen the compact sizes below are left exactly as they were.
        "tap-target inline-flex items-center justify-center gap-2 font-medium transition-colors cursor-pointer disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-primary",
        VARIANTS[variant],
        SIZES[size],
        collapse && "max-sm:aspect-square max-sm:px-0",
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";

/**
 * A button's text, hidden visually below `sm` but kept for assistive
 * technology, so a collapsed button keeps its accessible name.
 */
export function ButtonLabel({ children }: { children: React.ReactNode }) {
  return <span className="max-sm:sr-only">{children}</span>;
}
