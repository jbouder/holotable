"use client";

import * as React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Inline error banner with a retry affordance. Used across the generation and
 * query surfaces so a failed prompt or query always leaves the user a message
 * and a one-click way to try again.
 */
export function RetryNotice({
  message,
  onRetry,
  retryLabel = "Retry",
  disabled,
}: {
  message: string;
  onRetry: () => void;
  retryLabel?: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">{message}</span>
      <Button variant="secondary" size="sm" onClick={onRetry} disabled={disabled}>
        <RefreshCw className="h-3.5 w-3.5" />
        {retryLabel}
      </Button>
    </div>
  );
}
