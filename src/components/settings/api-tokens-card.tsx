"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { CopyButton } from "@/components/settings/copy-button";
import { useTimeDisplay } from "@/components/time-display";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorDisplay } from "@/components/ui/error-display";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { ApiTokenView } from "@/lib/api-token-view";
import { type ApiError, apiErrorFromThrown, readApiError } from "@/lib/errors";
import { formatInstant } from "@/lib/time-range";

/**
 * One workspace's service-account tokens (#288): create one (shown once),
 * see which are used, revoke.
 */
export function ApiTokensCard({
  workspaceId,
  maxDays,
}: {
  workspaceId: string;
  maxDays: number;
}) {
  const display = useTimeDisplay();
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/tokens`;
  const [tokens, setTokens] = React.useState<ApiTokenView[] | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState<"viewer" | "editor">("editor");
  const [days, setDays] = React.useState(String(Math.min(30, maxDays)));
  const [created, setCreated] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const dayOptions = [...new Set([1, 7, 30, 90, maxDays])]
    .filter((d) => d <= maxDays)
    .sort((a, b) => a - b)
    .map((d) => ({ value: String(d), label: d === 1 ? "1 day" : `${d} days` }));

  const load = React.useCallback(async () => {
    try {
      const res = await fetch(base);
      if (!res.ok) {
        setError(await readApiError(res));
        return;
      }
      setTokens(((await res.json()) as { tokens: ApiTokenView[] }).tokens);
    } catch (err) {
      setError(apiErrorFromThrown(err));
    }
  }, [base]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), role, expiresInDays: Number(days) }),
      });
      if (!res.ok) {
        setError(await readApiError(res));
        return;
      }
      setCreated(((await res.json()) as { token: string }).token);
      setName("");
      await load();
    } catch (err) {
      setError(apiErrorFromThrown(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      const res = await fetch(`${base}/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) setError(await readApiError(res));
      await load();
    } catch (err) {
      setError(apiErrorFromThrown(err));
    }
  }

  const live = (tokens ?? []).filter(
    (t) => t.revokedAt === null && Date.parse(t.expiresAt) > Date.now(),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{workspaceId}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {created && (
          <div className="space-y-2 border border-success/40 bg-success/10 p-3">
            <p className="font-medium">Copy the token now; it will not be shown again.</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-xs">{created}</code>
              <CopyButton value={created} label="Copy token" />
            </div>
          </div>
        )}
        <form
          className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_auto_auto_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void create();
          }}
        >
          <div>
            <Label htmlFor={`token-name-${workspaceId}`}>Name</Label>
            <Input
              id={`token-name-${workspaceId}`}
              maxLength={100}
              placeholder="e.g. deploy pipeline"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor={`token-role-${workspaceId}`}>Role</Label>
            <Select
              id={`token-role-${workspaceId}`}
              value={role}
              onValueChange={(v) => setRole(v as "viewer" | "editor")}
              options={[
                { value: "viewer", label: "viewer" },
                { value: "editor", label: "editor" },
              ]}
            />
          </div>
          <div>
            <Label htmlFor={`token-days-${workspaceId}`}>Expires after</Label>
            <Select
              id={`token-days-${workspaceId}`}
              value={days}
              onValueChange={setDays}
              options={dayOptions}
            />
          </div>
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Create token
          </Button>
        </form>
        {error && <ErrorDisplay error={error} />}
        {tokens === null ? (
          <p className="text-muted">Loading…</p>
        ) : live.length === 0 ? (
          <p className="text-muted">No active tokens.</p>
        ) : (
          <ul className="divide-y divide-border border-y border-border">
            {live.map((t) => (
              <li key={t.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {t.name}{" "}
                    <span className="text-xs font-normal text-muted">· {t.role}</span>
                  </p>
                  <p className="text-xs text-muted">
                    Expires {formatInstant(new Date(t.expiresAt), display)} ·{" "}
                    {t.lastUsedAt
                      ? `last used ${formatInstant(new Date(t.lastUsedAt), display)}`
                      : "never used"}
                  </p>
                </div>
                <Button variant="secondary" size="sm" onClick={() => void revoke(t.id)}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
