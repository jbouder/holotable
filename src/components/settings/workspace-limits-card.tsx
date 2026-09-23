"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { apiErrorFromThrown, readApiError } from "@/lib/errors";
// Types only: the module itself reaches the server-only limiter.
import type { LimitView, WorkspaceLimitsView } from "@/lib/workspace-limits";

const fmt = new Intl.NumberFormat("en-US");

function SourceBadge({ limit }: { limit: LimitView }) {
  return (
    <Badge variant="outline">
      {limit.source === "override" ? "Workspace override" : "Default"}
    </Badge>
  );
}

/** A blank field inherits; anything else must be a whole number of 0 or more. */
function parseField(value: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = value.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? { ok: true, value: n } : { ok: false };
}

/**
 * One workspace's model usage today against its limits (#218). A platform
 * admin also gets the override form; everyone else who sees the card reads it.
 */
export function WorkspaceLimitsCard({
  initial,
  canEdit,
}: {
  initial: WorkspaceLimitsView;
  canEdit: boolean;
}) {
  const [view, setView] = React.useState(initial);
  const [rate, setRate] = React.useState(
    initial.ratePerMinute.override?.toString() ?? "",
  );
  const [budget, setBudget] = React.useState(
    initial.dailyTokenBudget.override?.toString() ?? "",
  );
  const [status, setStatus] = React.useState<
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "saved" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const { usage, dailyTokenBudget: b, ratePerMinute: r } = view;
  const used = b.disabled ? 0 : Math.min(1, usage.totalTokens / Math.max(1, b.effective));
  const id = view.workspaceId;
  const fieldId = React.useId();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const nextRate = parseField(rate);
    const nextBudget = parseField(budget);
    if (!nextRate.ok || !nextBudget.ok) {
      setStatus({
        kind: "error",
        message: "Use a whole number of 0 or more, or leave it blank.",
      });
      return;
    }
    setStatus({ kind: "saving" });
    try {
      const res = await fetch(`/api/workspaces/${encodeURIComponent(id)}/limits`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ratePerMinute: nextRate.value,
          dailyTokenBudget: nextBudget.value,
        }),
      });
      if (!res.ok) {
        setStatus({ kind: "error", message: (await readApiError(res)).error });
        return;
      }
      setView((await res.json()) as WorkspaceLimitsView);
      setStatus({ kind: "saved" });
    } catch (err) {
      setStatus({ kind: "error", message: apiErrorFromThrown(err).error });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono">{id}</CardTitle>
        <a
          href={`/api/generation-log?workspaceId=${encodeURIComponent(id)}`}
          className="text-xs text-primary hover:underline"
        >
          Generation log (JSON)
        </a>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-3">
        <div>
          <p className="text-xs text-muted">Tokens used today (UTC)</p>
          <p className="mt-1 text-lg font-semibold">{fmt.format(usage.totalTokens)}</p>
          <p className="text-xs text-muted">
            {fmt.format(usage.inputTokens)} in · {fmt.format(usage.outputTokens)} out ·{" "}
            {fmt.format(usage.requests)} {usage.requests === 1 ? "request" : "requests"}
          </p>
        </div>
        <div>
          <p className="flex items-center gap-2 text-xs text-muted">
            Daily token budget <SourceBadge limit={b} />
          </p>
          <p className="mt-1 text-lg font-semibold">
            {b.disabled ? "No limit" : fmt.format(b.effective)}
          </p>
          {!b.disabled && (
            <>
              {/* Decorative: the "left" line below says the same in words. */}
              <div className="mt-1 h-1.5 w-full bg-surface-2" aria-hidden>
                <div
                  className={
                    used >= 1
                      ? "h-full bg-danger"
                      : used >= 0.8
                        ? "h-full bg-warning"
                        : "h-full bg-primary"
                  }
                  style={{ width: `${used * 100}%` }}
                />
              </div>
              <p className="mt-1 text-xs text-muted">
                {fmt.format(b.remaining ?? 0)} left · resets at midnight UTC
              </p>
            </>
          )}
        </div>
        <div>
          <p className="flex items-center gap-2 text-xs text-muted">
            Rate limit <SourceBadge limit={r} />
          </p>
          <p className="mt-1 text-lg font-semibold">
            {r.disabled ? "No limit" : `${fmt.format(r.effective)} / min`}
          </p>
          {!r.disabled && <p className="text-xs text-muted">Model requests per person</p>}
        </div>
      </CardContent>

      {canEdit && (
        <form onSubmit={(e) => void save(e)} className="border-t border-border px-4 py-3">
          <p className="text-xs text-muted">
            Leave a field blank to use the default. 0 turns the limit off.
          </p>
          <div className="mt-2 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div className="text-sm">
              <label htmlFor={`${fieldId}-budget`} className="text-xs text-muted">
                Daily token budget
              </label>
              <Input
                id={`${fieldId}-budget`}
                inputMode="numeric"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                placeholder={`Default: ${fmt.format(b.global)}`}
              />
            </div>
            <div className="text-sm">
              <label htmlFor={`${fieldId}-rate`} className="text-xs text-muted">
                Requests per minute per person
              </label>
              <Input
                id={`${fieldId}-rate`}
                inputMode="numeric"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder={`Default: ${fmt.format(r.global)}`}
              />
            </div>
            <Button type="submit" disabled={status.kind === "saving"}>
              {status.kind === "saving" ? "Saving…" : "Save limits"}
            </Button>
          </div>
          <p role="status" className="mt-2 text-xs">
            {status.kind === "saved" && (
              <span className="text-success">
                Saved. The next model call uses the new limits.
              </span>
            )}
            {status.kind === "error" && (
              <span className="text-danger">{status.message}</span>
            )}
          </p>
        </form>
      )}
    </Card>
  );
}
