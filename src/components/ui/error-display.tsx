"use client";

import { AlertTriangle, DatabaseZap, Lock, RefreshCw, ServerCrash } from "lucide-react";
import { type ApiError, type ErrorPresentation, presentError } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The one way an error is shown.
 *
 * Two modes, and which one you get is not a prop — it comes from the error's
 * `kind`, so invariant 16's split is visible to the user instead of being an
 * implementation detail of the server. An actionable error shows the real
 * message and the next step; an opaque one shows a generic sentence and the
 * request id, which is the only useful thing the user can do with it.
 *
 * `layout` is the only real choice: `inline` is the banner that sits above a
 * form or a prompt box, `block` fills a panel body.
 */
export function ErrorDisplay({
  error,
  onRetry,
  retryLabel = "Retry",
  disabled,
  layout = "inline",
  className,
}: {
  error: ApiError | ErrorPresentation;
  onRetry?: () => void;
  retryLabel?: string;
  disabled?: boolean;
  layout?: "inline" | "block";
  className?: string;
}) {
  const shown = "actionable" in error ? error : presentError(error);
  const Icon = ICONS[shown.kind] ?? AlertTriangle;
  // A removed source or a missing dashboard is a state to correct, not a
  // failure to alarm about — red is reserved for something that actually broke.
  const tone = MUTED_KINDS.has(shown.kind) ? "text-muted" : "text-danger";
  // A denial is not retryable by pressing the same button again, so the
  // affordance is withheld rather than offered and disappointed.
  const retry = shown.kind === "authorization" ? undefined : onRetry;

  if (layout === "block") {
    return (
      <div
        role="alert"
        className={cn(
          "flex h-full flex-col items-center justify-center gap-2 px-3 text-center text-sm",
          className,
        )}
      >
        <Icon className={cn("h-5 w-5 shrink-0", tone)} />
        <p className="line-clamp-3 break-words text-foreground">{shown.message}</p>
        <Hint shown={shown} className="line-clamp-2" />
        <RequestId shown={shown} />
        {retry && (
          <Button
            variant="secondary"
            size="sm"
            className="mt-1"
            onClick={retry}
            disabled={disabled}
          >
            <RefreshCw className="h-3.5 w-3.5" /> {retryLabel}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-start gap-3 border border-danger/30 bg-danger/10 px-3 py-2 text-sm",
        className,
      )}
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", tone)} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="break-words text-danger">{shown.message}</p>
        <Hint shown={shown} />
        <RequestId shown={shown} />
      </div>
      {retry && (
        <Button variant="secondary" size="sm" onClick={retry} disabled={disabled}>
          <RefreshCw className="h-3.5 w-3.5" /> {retryLabel}
        </Button>
      )}
    </div>
  );
}

const MUTED_KINDS = new Set<ErrorPresentation["kind"]>(["conflict", "not_found"]);

const ICONS: Partial<Record<ErrorPresentation["kind"], typeof AlertTriangle>> = {
  authorization: Lock,
  conflict: DatabaseZap,
  infrastructure: ServerCrash,
};

function Hint({ shown, className }: { shown: ErrorPresentation; className?: string }) {
  if (!shown.hint) return null;
  return <p className={cn("text-xs text-muted", className)}>{shown.hint}</p>;
}

/**
 * Only on the opaque path. On an actionable error the message is already the
 * answer, and an id the user has no use for is noise.
 */
function RequestId({ shown }: { shown: ErrorPresentation }) {
  if (!shown.requestId) return null;
  return (
    <p className="text-xs text-muted">
      Quote request <code className="font-mono text-foreground">{shown.requestId}</code>{" "}
      when reporting this.
    </p>
  );
}
