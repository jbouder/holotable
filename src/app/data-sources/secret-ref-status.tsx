"use client";

import * as React from "react";
import { AlertTriangle, Ban, Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type GrantedSecretRefsState,
  type SecretRefReadiness,
  fetchGrantedSecretRefs,
} from "@/lib/secret-refs";

/**
 * `secret_ref` readiness: the hook that asks, and the lines that report.
 *
 * What a ref means and what the server may say about it live in
 * `@/lib/secret-refs`; this file is the wiring and the wording.
 */

/**
 * The refs granted to `workspaceId`, each with whether it resolves.
 *
 * One request per workspace serves the form's picker, its readiness line and
 * every row of the source list: several sources commonly share one ref, and
 * the list is bounded by what the operator declared, so there is nothing to
 * gain from asking about refs one at a time. A change of workspace abandons
 * the request in flight, so the state is never an answer about another one.
 */
export function useGrantedSecretRefs(workspaceId: string | null): GrantedSecretRefsState {
  const [list, setList] = React.useState<GrantedSecretRefsState>({ state: "loading" });

  React.useEffect(() => {
    if (!workspaceId) return;
    setList({ state: "loading" });
    const controller = new AbortController();
    void (async () => {
      const outcome = await fetchGrantedSecretRefs(workspaceId, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setList(
        outcome.ok
          ? { state: "ready", refs: outcome.refs }
          : { state: "error", error: outcome.error },
      );
    })();
    return () => controller.abort();
  }, [workspaceId]);

  return list;
}

/** One line of readiness under the `secret_ref` field. */
export function SecretRefReadinessLine({
  readiness,
  className,
}: {
  readiness: SecretRefReadiness;
  className?: string;
}) {
  const base = cn("mt-1 flex items-start gap-1.5 text-xs", className);

  switch (readiness.state) {
    case "checking":
      return (
        <p className={cn(base, "text-muted")}>
          <Loader2 className="mt-px h-3 w-3 shrink-0 animate-spin" />
          Checking the server for credentials…
        </p>
      );
    case "configured":
      return (
        <p className={cn(base, "text-success")}>
          <Check className="mt-px h-3 w-3 shrink-0" />
          Credentials for {readiness.ref} are configured on the server.
        </p>
      );
    case "missing":
      return (
        <p className={cn(base, "text-warning")}>
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          {readiness.message}
        </p>
      );
    case "not-granted":
      return (
        <p className={cn(base, "text-danger")}>
          <Ban className="mt-px h-3 w-3 shrink-0" />
          {readiness.message}
        </p>
      );
    case "error":
      // The check failing says nothing about the credentials either way, so it
      // is reported as what it is rather than as a missing secret.
      return (
        <p className={cn(base, "text-muted")}>
          Could not check credential readiness right now.
        </p>
      );
  }
}

/** The compact form, for a row in the source list: an icon and a title, no sentence. */
export function SecretRefBadge({ readiness }: { readiness: SecretRefReadiness }) {
  switch (readiness.state) {
    case "configured":
      return (
        <span
          className="inline-flex items-center gap-1 text-xs text-success"
          title={`Credentials for ${readiness.ref} are configured on the server.`}
        >
          <Check className="h-3.5 w-3.5" /> Ready
        </span>
      );
    case "missing":
      return (
        <span
          className="inline-flex items-center gap-1 text-xs text-warning"
          title={readiness.message}
        >
          <AlertTriangle className="h-3.5 w-3.5" /> No credentials
        </span>
      );
    case "not-granted":
      return (
        <span
          className="inline-flex items-center gap-1 text-xs text-danger"
          title={readiness.message}
        >
          <Ban className="h-3.5 w-3.5" /> Not granted
        </span>
      );
    case "checking":
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />;
    default:
      return <span className="text-xs text-muted">—</span>;
  }
}
