"use client";

import * as React from "react";
import { AlertTriangle, Check, Clock, Loader2, RefreshCw } from "lucide-react";
import { RefreshCatalogDialog } from "@/components/sources/catalog-refresh";
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
 * being handed a button that would come back 403. With it, Refresh opens the
 * same reviewed refresh as the source list (#123): the diff first, and nothing
 * written until it is applied.
 */
export function CatalogHealthNotice({
  source,
  health,
  canRefresh,
  onRefreshed,
}: {
  source: Named;
  health: CatalogHealth | undefined;
  canRefresh: boolean;
  /** After an applied refresh, with the state it produced. */
  onRefreshed: (health: CatalogHealth) => void;
}) {
  const [reviewing, setReviewing] = React.useState(false);
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
          onClick={() => setReviewing(true)}
        >
          <RefreshCw className="h-4 w-4" />
          Refresh catalog
        </Button>
      )}
      <RefreshCatalogDialog
        source={reviewing ? source : null}
        onClose={() => setReviewing(false)}
        onApplied={({ catalogHealth }) => {
          setReviewing(false);
          onRefreshed(catalogHealth);
        }}
      />
    </div>
  );
}

/**
 * The catalog states a picker shows, corrected in place by a refresh from it.
 *
 * The pickers render sources the server projected once at page load, so after
 * a refresh they would otherwise still be showing the state the page was built
 * with. The hook keeps the corrections made in this session, keyed by source id.
 */
export function useCatalogRefresh(initial: Record<string, CatalogHealth>) {
  const [health, setHealth] = React.useState(initial);
  const update = React.useCallback((sourceId: string, next: CatalogHealth) => {
    setHealth((h) => ({ ...h, [sourceId]: next }));
  }, []);
  return { health, update };
}
