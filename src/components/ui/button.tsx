"use client";

import * as React from "react";
import Link from "next/link";
import { Button as BaseButton } from "@base-ui/react/button";
import { buttonClassName, type Size, type Variant } from "@/components/ui/button-styles";

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
      className={
        // Base UI also takes a function of the button's state.
        typeof className === "function"
          ? (state) =>
              buttonClassName({ variant, size, collapse, className: className(state) })
          : buttonClassName({ variant, size, collapse, className })
      }
      {...props}
    />
  ),
);
Button.displayName = "Button";

/**
 * A link that looks like a button (#77). A `<Button>` inside a `<Link>` is two
 * tab stops for one action and a button nested in a link, which assistive
 * technology announces as both; this is one element, announced as the link it
 * is.
 */
export function ButtonLink({
  variant,
  size,
  collapse,
  className,
  ...props
}: React.ComponentProps<typeof Link> & {
  variant?: Variant;
  size?: Size;
  collapse?: boolean;
}) {
  return (
    <Link
      className={buttonClassName({ variant, size, collapse, className })}
      {...props}
    />
  );
}

/**
 * A button's text, hidden visually below `sm` but kept for assistive
 * technology, so a collapsed button keeps its accessible name.
 */
export function ButtonLabel({ children }: { children: React.ReactNode }) {
  return <span className="max-sm:sr-only">{children}</span>;
}
