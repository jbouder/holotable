import * as React from "react";
import { cn } from "@/lib/utils";

type Variant = "default" | "outline";

const VARIANTS: Record<Variant, string> = {
  default: "bg-surface-2 text-muted border-border",
  outline: "bg-transparent text-muted border-border",
};

export interface BadgeProps extends React.ComponentPropsWithoutRef<"span"> {
  variant?: Variant;
}

export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
