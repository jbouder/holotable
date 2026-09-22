"use client";

import * as React from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type SecretRefReadiness,
  fetchSecretRefStatus,
  readinessFor,
  readinessFromStatus,
} from "@/lib/secret-refs";

/**
 * Live `secret_ref` readiness: the hook that asks, and the line that reports.
 *
 * What a ref means and what the server may say about it live in
 * `@/lib/secret-refs`; this file is the wiring and the wording.
 */

/**
 * How long a ref has to stop changing before it is checked.
 *
 * A `secret_ref` is typed a character at a time and almost every prefix of a
 * real one is itself well-formed, so checking on each keystroke would spend
 * the endpoint's whole per-minute allowance answering about refs that were
 * never finished.
 */
export const READINESS_DEBOUNCE_MS = 350;

/**
 * Whether the server holds credentials for `secretRef`, kept current as it is
 * typed.
 *
 * A ref that cannot be valid is settled here without a request, and each new
 * ref aborts the check in flight for the previous one, so the state can never
 * be a stale answer about a ref the user has already moved on from.
 */
export function useSecretRefReadiness(
  workspaceId: string,
  secretRef: string,
  debounceMs: number = READINESS_DEBOUNCE_MS,
): SecretRefReadiness {
  const [readiness, setReadiness] = React.useState<SecretRefReadiness>(() =>
    readinessFor(secretRef),
  );

  React.useEffect(() => {
    const pending = readinessFor(secretRef);
    setReadiness(pending);
    if (pending.state !== "checking") return;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        const outcome = await fetchSecretRefStatus(
          { workspaceId, secretRef: secretRef.trim() },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setReadiness(
          outcome.ok
            ? readinessFromStatus(outcome.status)
            : { state: "error", error: outcome.error },
        );
      })();
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [workspaceId, secretRef, debounceMs]);

  return readiness;
}

/**
 * One line of readiness under the `secret_ref` field.
 *
 * `invalid` renders nothing: the field's own validation error already says the
 * ref is misspelled, and a second sentence about it would only compete.
 */
export function SecretRefReadinessLine({
  readiness,
  className,
}: {
  readiness: SecretRefReadiness;
  className?: string;
}) {
  if (readiness.state === "idle" || readiness.state === "invalid") return null;

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

/**
 * The compact form, for a row in the source list: an icon and a title, no
 * sentence. `idle` and `invalid` cannot occur for a stored source — it was
 * saved through the same schema — but are rendered as unknown rather than
 * asserted away.
 */
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
    case "checking":
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />;
    default:
      return <span className="text-xs text-muted">—</span>;
  }
}

/**
 * Readiness for a whole list of sources, keyed by ref.
 *
 * Asked once per *distinct* ref rather than once per row: several sources
 * commonly share one env family, and a list that checked each row separately
 * would spend the endpoint's allowance re-asking the same question. There is
 * no debounce here — the refs come from stored records, not from a keyboard —
 * but the whole batch is abandoned if the list changes under it.
 */
export function useSecretRefReadinessMap(
  workspaceId: string | null,
  secretRefs: string[],
): Record<string, SecretRefReadiness> {
  // The distinct refs as one primitive, so the effect re-runs when the set
  // changes and not merely when the array identity does.
  const key = [...new Set(secretRefs)].sort().join("\u0000");
  const [map, setMap] = React.useState<Record<string, SecretRefReadiness>>({});

  React.useEffect(() => {
    if (!workspaceId || key === "") return;
    const refs = key.split("\u0000");
    setMap(Object.fromEntries(refs.map((ref) => [ref, readinessFor(ref)])));

    const controller = new AbortController();
    void Promise.all(
      refs.map(async (ref) => {
        const outcome = await fetchSecretRefStatus(
          { workspaceId, secretRef: ref },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setMap((current) => ({
          ...current,
          [ref]: outcome.ok
            ? readinessFromStatus(outcome.status)
            : { state: "error", error: outcome.error },
        }));
      }),
    );

    return () => controller.abort();
  }, [workspaceId, key]);

  return map;
}
