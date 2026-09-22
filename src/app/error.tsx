"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Route-level error boundary.
 *
 * Panels have their own boundary (`PanelErrorBoundary`), so this catches what
 * is left: a throw in a page, a layout child, or any dashboard chrome outside
 * the grid. Without it React unwinds past the route and the user gets a blank
 * screen with no way back short of a manual reload.
 *
 * `reset()` re-renders the route segment, which is enough for a transient
 * failure; the reload is there for one that is not.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Card className="max-w-lg">
        <CardContent className="flex flex-col items-center gap-3 px-8 py-8 text-center">
          <AlertTriangle className="h-6 w-6 text-danger" />
          <h1 className="text-base font-semibold">Something went wrong</h1>
          <p className="text-sm text-muted">
            {error.message || "This page failed to render."}
          </p>
          {error.digest && (
            <p className="font-mono text-xs text-muted">digest: {error.digest}</p>
          )}
          <div className="mt-1 flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={reset}>
              <RefreshCw className="h-3.5 w-3.5" /> Try again
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                window.location.reload();
              }}
            >
              Reload
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
