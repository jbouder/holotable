"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Copies `value`, and says so, or says it could not. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = React.useState<"idle" | "copied" | "failed">("idle");

  React.useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2_000);
    return () => clearTimeout(timer);
  }, [state]);

  // `navigator.clipboard` is absent outside a secure context, so the property
  // access itself can throw. Both failure modes land in the same notice.
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        aria-label={label}
        title={label}
        onClick={() => void copy()}
      >
        {state === "copied" ? (
          <Check className="h-4 w-4" />
        ) : (
          <Copy className="h-4 w-4" />
        )}
      </Button>
      <span role="status" className="text-xs text-muted">
        {state === "copied"
          ? "Copied"
          : state === "failed"
            ? "Could not reach the clipboard"
            : ""}
      </span>
    </span>
  );
}
