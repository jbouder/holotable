"use client";

import * as React from "react";
import { Plus, Trash2, RefreshCw, Plug, Loader2 } from "lucide-react";
import type { SourceRecord } from "@/lib/registry";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const CONFIG_TEMPLATE = JSON.stringify(
  {
    protocol: "http",
    host: "clickhouse",
    port: 8123,
    database: "metrics",
    tables: [
      {
        name: "http_requests",
        description: "per-request events",
        timeField: "ts",
        columns: [
          { name: "ts", type: "DateTime64(3)" },
          { name: "status", type: "UInt16" },
          { name: "duration_ms", type: "Float64" },
        ],
      },
    ],
  },
  null,
  2,
);

export function SourcesClient({ workspaces }: { workspaces: string[] }) {
  const [workspaceId, setWorkspaceId] = React.useState<string | null>(
    workspaces[0] ?? null,
  );
  const [sources, setSources] = React.useState<SourceRecord[] | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const load = React.useCallback(async (ws: string) => {
    const res = await fetch(`/api/sources?workspaceId=${encodeURIComponent(ws)}`);
    const body = await res.json();
    setSources(res.ok ? body.sources : []);
  }, []);

  React.useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    void (async () => {
      const res = await fetch(
        `/api/sources?workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      const body = await res.json();
      if (active) setSources(res.ok ? body.sources : []);
    })();
    return () => {
      active = false;
    };
  }, [workspaceId]);

  async function test(id: string) {
    setBusy(id);
    const res = await fetch(`/api/sources/${id}/test`, { method: "POST" });
    const body = await res.json();
    setNotice(`${id}: ${body.message ?? (res.ok ? "ok" : "failed")}`);
    setBusy(null);
  }

  async function refresh(id: string) {
    setBusy(id);
    const res = await fetch(`/api/sources/${id}/refresh`, { method: "POST" });
    setNotice(res.ok ? `${id}: catalog refreshed` : `${id}: refresh failed`);
    setBusy(null);
    if (workspaceId) void load(workspaceId);
  }

  async function remove(id: string) {
    setBusy(id);
    const res = await fetch(`/api/sources/${id}`, { method: "DELETE" });
    const body = await res.json();
    setNotice(res.ok ? `${id}: ${body.outcome}` : `${id}: delete failed`);
    setBusy(null);
    if (workspaceId) void load(workspaceId);
  }

  if (workspaces.length === 0) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card>
          <CardContent className="text-sm text-muted">
            You need the <code>source-admin</code> role in a workspace to manage
            data sources.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Data sources</h1>
        <div>
          <Label htmlFor="ws">Workspace</Label>
          <Select
            id="ws"
            value={workspaceId}
            onValueChange={setWorkspaceId}
            options={workspaces.map((w) => ({ value: w, label: w }))}
          />
        </div>
      </div>

      {notice && (
        <div className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-muted">
          {notice}
        </div>
      )}

      {sources === null ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <div className="grid gap-3">
          {sources.map((s) => (
            <Card key={s.id}>
              <CardContent className="flex items-center justify-between">
                <div>
                  <div className="font-medium">
                    {s.name}{" "}
                    {s.tombstonedAt && (
                      <span className="text-xs text-danger">(tombstoned)</span>
                    )}
                  </div>
                  <div className="text-xs text-muted">
                    {s.id} · {s.config.protocol}://{s.config.host}:{s.config.port}/
                    {s.config.database} · secret_ref {s.secretRef} ·{" "}
                    {s.config.tables.length} tables
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" disabled={busy === s.id} onClick={() => test(s.id)}>
                    <Plug className="h-4 w-4" /> Test
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy === s.id} onClick={() => refresh(s.id)}>
                    <RefreshCw className="h-4 w-4" /> Refresh
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy === s.id} onClick={() => remove(s.id)}>
                    <Trash2 className="h-4 w-4 text-danger" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
          {sources.length === 0 && (
            <p className="text-sm text-muted">No sources in this workspace yet.</p>
          )}
        </div>
      )}

      {workspaceId && (
        <CreateSource
          workspaceId={workspaceId}
          onCreated={() => {
            setNotice("source created");
            void load(workspaceId);
          }}
        />
      )}
    </div>
  );
}

function CreateSource({
  workspaceId,
  onCreated,
}: {
  workspaceId: string;
  onCreated: () => void;
}) {
  const [id, setId] = React.useState("");
  const [name, setName] = React.useState("");
  const [secretRef, setSecretRef] = React.useState("CH_METRICS");
  const [configText, setConfigText] = React.useState(CONFIG_TEMPLATE);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    let config: unknown;
    try {
      config = JSON.parse(configText);
    } catch {
      setError("config is not valid JSON");
      return;
    }
    setSaving(true);
    const res = await fetch("/api/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, id, name, secretRef, config }),
    });
    const body = await res.json();
    setSaving(false);
    if (!res.ok) {
      setError(body.error ?? "create failed");
      return;
    }
    setId("");
    setName("");
    onCreated();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add source</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={create} className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label htmlFor="s-id">Source id</Label>
              <Input id="s-id" value={id} onChange={(e) => setId(e.target.value)} placeholder="ch-metrics" />
            </div>
            <div>
              <Label htmlFor="s-name">Name</Label>
              <Input id="s-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Metrics" />
            </div>
            <div>
              <Label htmlFor="s-secret">secret_ref (env family)</Label>
              <Input id="s-secret" value={secretRef} onChange={(e) => setSecretRef(e.target.value)} />
            </div>
          </div>
          <div>
            <Label htmlFor="s-config">Connection + catalog (JSON)</Label>
            <Textarea
              id="s-config"
              rows={12}
              className="font-mono text-xs"
              value={configText}
              onChange={(e) => setConfigText(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <Button type="submit" disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Create source
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
