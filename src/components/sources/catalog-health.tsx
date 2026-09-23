"use client";

import * as React from "react";
import { AlertTriangle, Check, Clock, Loader2, RefreshCw } from "lucide-react";
import {
  type CatalogHealth,
  type CatalogSubject,
  catalogHealthLabel,
  describeCatalogHealth,
} from "@/lib/catalog/health";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * How a source's catalog state is shown, wherever a source is chosen.
 *
 * The state itself is decided on the server (`catalogHealth`), because the
 * threshold is an environment setting and because `/api/generate` refuses on
 * exactly the same judgement. This file only renders it, and it renders the
 * *same sentence* the refusal would give, so nobody meets the problem for the
 * first time as a rejected generation.
 */

type Named = Pick<CatalogSubject, "id" | "name">;

const TONE: Record<CatalogHealth["state"], string> = {
  ok: "text-success",
  empty: "text-danger",
  never_refreshed: "text-danger",
  drifted: "text-warning",
  stale: "text-warning",
};

function Icon({ state }: { state: CatalogHealth["state"] }) {
  if (state === "ok") return <Check className="h-3.5 w-3.5 shrink-0" />;
  if (state === "stale") return <Clock className="h-3.5 w-3.5 shrink-0" />;
  return <AlertTriangle className="h-3.5 w-3.5 shrink-0" />;
}

/** The compact form, for a row in the source list: an icon, a label, a title. */
export function CatalogHealthBadge({
  source,
  health,
  className,
}: {
  source: Named;
  health: CatalogHealth | undefined;
  className?: string;
}) {
  if (!health) return <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs",
        TONE[health.state],
        className,
      )}
      title={describeCatalogHealth(source, health)}
    >
      <Icon state={health.state} />
      {catalogHealthLabel(health)}
    </span>
  );
}

/**
 * The full form, for the source pickers: the sentence, and the Refresh that
 * fixes it. A healthy catalog renders nothing — the notice exists to report a
 * problem, and a permanent "all good" line beside every picker would only
 * train people to stop reading it.
 *
 * `canRefresh` is the caller's `source:manage` decision. Without it the reader
 * still gets told what is wrong; they just get told to ask an admin instead of
 * being handed a button that would come back 403.
 */
export function CatalogHealthNotice({
  source,
  health,
  canRefresh,
  onRefresh,
  busy = false,
  error,
}: {
  source: Named;
  health: CatalogHealth | undefined;
  canRefresh: boolean;
  onRefresh: () => void;
  busy?: boolean;
  error?: string | null;
}) {
  if (!health || health.state === "ok") return null;

  return (
    <div
      role={health.blocked ? "alert" : "status"}
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 border px-3 py-2 text-xs",
        health.blocked
          ? "border-danger/40 bg-danger/5 text-danger"
          : "border-warning/40 bg-warning/5 text-warning",
      )}
    >
      <span className="flex min-w-0 items-start gap-1.5">
        <Icon state={health.state} />
        <span className="min-w-0">
          {describeCatalogHealth(source, health)}
          {!canRefresh && " Ask a source admin for this workspace to refresh it."}
        </span>
      </span>
      {canRefresh && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onRefresh}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Refresh catalog
        </Button>
      )}
      {error && <span className="text-muted">{error}</span>}
    </div>
  );
}

/**
 * The Refresh a picker offers: one call, and the fresh state it produced.
 *
 * The pickers render sources the server projected once at page load, so after
 * a refresh they would otherwise still be showing the state the page was built
 * with. The hook keeps the corrections it has made in this session and hands
 * them back keyed by source id.
 */
export function useCatalogRefresh(initial: Record<string, CatalogHealth>) {
  const [health, setHealth] = React.useState(initial);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<Record<string, string>>({});

  const refresh = React.useCallback(async (sourceId: string) => {
    setBusy(sourceId);
    setError((e) => ({ ...e, [sourceId]: "" }));
    try {
      const res = await fetch(`/api/sources/${encodeURIComponent(sourceId)}/refresh`, {
        method: "POST",
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          (body as { error?: string } | null)?.error ?? "the refresh failed";
        setError((e) => ({ ...e, [sourceId]: message }));
        return;
      }
      const next = (body as { catalogHealth?: CatalogHealth } | null)?.catalogHealth;
      if (next) setHealth((h) => ({ ...h, [sourceId]: next }));
    } finally {
      setBusy(null);
    }
  }, []);

  return { health, busy, error, refresh };
}
