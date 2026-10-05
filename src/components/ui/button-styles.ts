import { cn } from "@/lib/utils";

/*
 * How a button looks, apart from the component that is one. No "use client"
 * here on purpose: a Server Component that needs a plain `<a>` styled as a
 * button (the sign-in link, which must not be a client-side navigation) can
 * call `buttonClassName` from this module, and could not from `button.tsx`.
 */

export type Variant = "primary" | "secondary" | "ghost" | "danger";
export type Size = "sm" | "md" | "icon";

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

/** The classes a {@link Button} draws with, for anything that must look like one. */
export function buttonClassName({
  variant = "primary",
  size = "md",
  collapse = false,
  className,
}: {
  variant?: Variant;
  size?: Size;
  collapse?: boolean;
  className?: string;
}): string {
  return cn(
    // `tap-target` is the coarse-pointer minimum (#78): on a touch screen
    // every button grows to 44px in both directions, and on a mouse-driven
    // screen the compact sizes below are left exactly as they were.
    // `press` is the shared transition and the 4% dip on `:active` (#234);
    // it keys off `<html data-motion>` like every other motion rule.
    "tap-target press inline-flex items-center justify-center gap-2 font-medium cursor-pointer disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-primary",
    VARIANTS[variant],
    SIZES[size],
    collapse && "max-sm:aspect-square max-sm:px-0",
    className,
  );
}
