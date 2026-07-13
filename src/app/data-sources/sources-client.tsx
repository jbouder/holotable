"use client";

import * as React from "react";
import { experimental_useObject as useObject } from "@ai-sdk/react";
import {
  Plus,
  Trash2,
  RefreshCw,
  Plug,
  Loader2,
  Pencil,
  X,
  SendHorizontal,
} from "lucide-react";
import { SourceDraft, type SourceRecord } from "@/lib/registry";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** Starter descriptions to seed the natural-language drafter with one click. */
const SOURCE_PROMPT_PRESETS = [
  "TimescaleDB at metrics-db:5432, database prod, schema metrics. Track http_requests (ts, status, duration_ms) and cpu_usage (ts, host, pct).",
  "Postgres at localhost:5432, database app, public schema. Track an events table with a created_at timestamp, an event_type, and a user_id.",
  "TimescaleDB hypertable of IoT readings: a sensor_readings table keyed on time, with device_id, temperature, and humidity columns.",
];

const CONFIG_TEMPLATE = JSON.stringify(
  {
    host: "postgres",
    port: 5432,
    database: "holotable",
    schema: "metrics",
    ssl: false,
    tables: [
      {
        name: "http_requests",
        description: "per-request events",
        timeField: "ts",
        columns: [
          { name: "ts", type: "timestamp with time zone" },
          { name: "status", type: "smallint" },
          { name: "duration_ms", type: "double precision" },
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
  const [editing, setEditing] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
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

  const sourceBeingEdited = sources?.find((source) => source.id === editing);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Data sources</h1>
          <p className="mt-1 text-sm text-muted">
            Manage the connections that dashboards and Explore query against.
            Sources are scoped to a workspace and referenced by stable IDs.
          </p>
        </div>
        <div className="flex items-end gap-3">
          <div>
            <Label htmlFor="ws">Workspace</Label>
            <Select
              id="ws"
              value={workspaceId}
              onValueChange={(ws) => {
                setEditing(null);
                setCreating(false);
                setWorkspaceId(ws);
              }}
              options={workspaces.map((w) => ({ value: w, label: w }))}
            />
          </div>
          {sources !== null && (
            <Button
              onClick={() => {
                setNotice(null);
                setCreating(true);
              }}
            >
              <Plus className="h-4 w-4" /> Add source
            </Button>
          )}
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
        <>
          {sources.length === 0 ? (
            <p className="text-sm text-muted">No sources in this workspace yet.</p>
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeader>Name</TableHeader>
                  <TableHeader>Endpoint</TableHeader>
                  <TableHeader>Schema</TableHeader>
                  <TableHeader>Tables</TableHeader>
                  <TableHeader>Status</TableHeader>
                  <TableHeader className="text-right">Actions</TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {sources.map((source) => (
                  <TableRow key={source.id}>
                    <TableCell>
                      <div className="font-medium">{source.name}</div>
                      <div className="text-xs text-muted">{source.id}</div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {source.config.host}:{source.config.port}/
                      {source.config.database}
                    </TableCell>
                    <TableCell>{source.config.schema}</TableCell>
                    <TableCell>{source.config.tables.length}</TableCell>
                    <TableCell>
                      {source.tombstonedAt ? (
                        <span className="text-danger">Tombstoned</span>
                      ) : (
                        "Active"
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" disabled={busy === source.id} onClick={() => test(source.id)}>
                          <Plug className="h-4 w-4" /> Test
                        </Button>
                        <Button variant="ghost" size="sm" disabled={busy === source.id} onClick={() => refresh(source.id)}>
                          <RefreshCw className="h-4 w-4" /> Refresh
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy === source.id || !!source.tombstonedAt}
                          onClick={() => {
                            setNotice(null);
                            setEditing(source.id);
                          }}
                        >
                          <Pencil className="h-4 w-4" /> Edit
                        </Button>
                        <Button variant="ghost" size="sm" disabled={busy === source.id} onClick={() => remove(source.id)}>
                          <Trash2 className="h-4 w-4 text-danger" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}

      {workspaceId && (
        <Dialog open={creating} onOpenChange={setCreating} title="Add source">
          <CreateSourcePanel
            key={`create-${workspaceId}`}
            workspaceId={workspaceId}
            onCreated={() => {
              setCreating(false);
              setNotice("source created");
              void load(workspaceId);
            }}
            onCancel={() => setCreating(false)}
          />
        </Dialog>
      )}

      {sourceBeingEdited && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          title={`Edit ${sourceBeingEdited.name}`}
        >
          <SourceForm
            mode="edit"
            initial={{
              name: sourceBeingEdited.name,
              secretRef: sourceBeingEdited.secretRef,
              configText: JSON.stringify(sourceBeingEdited.config, null, 2),
            }}
            submitLabel="Save changes"
            onSubmit={async ({ name, secretRef, config }) => {
              const res = await fetch(`/api/sources/${sourceBeingEdited.id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, secretRef, config }),
              });
              const body = await res.json();
              if (!res.ok) return body.error ?? "update failed";
              setEditing(null);
              setNotice(`${sourceBeingEdited.id}: updated`);
              if (workspaceId) void load(workspaceId);
              return null;
            }}
            onCancel={() => setEditing(null)}
          />
        </Dialog>
      )}
    </div>
  );
}

/**
 * The "Add source" body: an optional natural-language drafter that seeds the
 * manual form below it. The model only ever drafts the safe config for review —
 * creation still goes through the same guarded POST /api/sources.
 */
function CreateSourcePanel({
  workspaceId,
  onCreated,
  onCancel,
}: {
  workspaceId: string;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [seed, setSeed] = React.useState<{
    id: string;
    name: string;
    secretRef: string;
    configText: string;
  }>();
  // Bumped on each draft so the form remounts and re-seeds from the new values.
  const [seedSeq, setSeedSeq] = React.useState(0);
  // The configuration form stays hidden until the drafter returns a result;
  // an explicit opt-in lets users skip the model and fill it in by hand.
  const [manual, setManual] = React.useState(false);
  const showForm = seed !== undefined || manual;

  return (
    <div className="space-y-4">
      <NaturalLanguageDrafter
        workspaceId={workspaceId}
        onDraft={(draft) => {
          setSeed({
            id: draft.id,
            name: draft.name,
            secretRef: draft.secretRef,
            configText: JSON.stringify(draft.config, null, 2),
          });
          setSeedSeq((n) => n + 1);
        }}
      />
      {showForm ? (
        <div className="border-t border-border pt-4">
          <SourceForm
            key={seedSeq}
            mode="create"
            submitLabel="Create source"
            initial={seed}
            onSubmit={async ({ id, name, secretRef, config }) => {
              const res = await fetch("/api/sources", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ workspaceId, id, name, secretRef, config }),
              });
              const body = await res.json();
              if (!res.ok) return body.error ?? "create failed";
              onCreated();
              return null;
            }}
            onCancel={onCancel}
          />
        </div>
      ) : (
        <div className="border-t border-border pt-4">
          <button
            type="button"
            onClick={() => setManual(true)}
            className="text-sm text-muted underline-offset-4 hover:text-foreground hover:underline"
          >
            or enter configuration manually
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Draft a source from plain English. Streams a validated SourceDraft (safe
 * config + catalog, never credentials) and hands the finished draft to the
 * caller to seed the review form.
 */
function NaturalLanguageDrafter({
  workspaceId,
  onDraft,
}: {
  workspaceId: string;
  onDraft: (draft: SourceDraft) => void;
}) {
  const [description, setDescription] = React.useState("");
  const { object, submit, isLoading, error, stop } = useObject({
    api: "/api/sources/generate",
    schema: SourceDraft,
    onFinish({ object }) {
      if (object) onDraft(object);
    },
  });

  function draft() {
    if (isLoading || !description.trim()) return;
    submit({ workspaceId, prompt: description });
  }

  return (
    <div className="space-y-2">
      <Label htmlFor="nl-source">Describe the source</Label>
      <p className="text-xs text-muted">
        Draft the connection and table catalog from plain English. Never include
        passwords — credentials come from the <code>secret_ref</code> environment
        family. Review the generated config below, then Test and Refresh to pull
        live columns.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {SOURCE_PROMPT_PRESETS.map((preset, i) => (
          <button
            key={i}
            type="button"
            disabled={isLoading}
            onClick={() => setDescription(preset)}
            title={preset}
            className="max-w-full truncate rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted transition-colors hover:border-primary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            {preset}
          </button>
        ))}
      </div>
      <div className="relative">
        <Textarea
          id="nl-source"
          rows={3}
          className="pr-14"
          placeholder="e.g. TimescaleDB at metrics-db:5432, database prod, schema metrics. Track http_requests (ts, status, duration_ms) and cpu_usage (ts, host, pct)."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              draft();
            }
          }}
        />
        <Button
          type="button"
          size="icon"
          onClick={draft}
          disabled={isLoading || !description.trim()}
          aria-label="Generate"
          title="Generate"
          className="absolute bottom-4 right-2"
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <SendHorizontal className="h-4 w-4" />
          )}
        </Button>
      </div>
      {isLoading && (
        <Button type="button" variant="ghost" size="sm" onClick={() => stop()}>
          Stop
        </Button>
      )}
      {error && (
        <p className="text-sm text-danger">Draft failed: {error.message}</p>
      )}
      {isLoading && object && (
        <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-surface p-3 text-xs text-muted">
          {JSON.stringify(object, null, 2)}
        </pre>
      )}
    </div>
  );
}

interface SourceFormValues {
  id: string;
  name: string;
  secretRef: string;
  config: unknown;
}

function SourceForm({
  mode,
  submitLabel,
  initial,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "edit";
  submitLabel: string;
  initial?: { id?: string; name: string; secretRef: string; configText: string };
  onSubmit: (values: SourceFormValues) => Promise<string | null>;
  onCancel?: () => void;
}) {
  const [id, setId] = React.useState(initial?.id ?? "");
  const [name, setName] = React.useState(initial?.name ?? "");
  const [secretRef, setSecretRef] = React.useState(initial?.secretRef ?? "TS_METRICS");
  const [configText, setConfigText] = React.useState(
    initial?.configText ?? CONFIG_TEMPLATE,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  async function submit(e: React.FormEvent) {
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
    const err = await onSubmit({ id, name, secretRef, config });
    setSaving(false);
    if (err) {
      setError(err);
      return;
    }
    if (mode === "create") {
      setId("");
      setName("");
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        {mode === "create" && (
          <div>
            <Label htmlFor="s-id">Source id</Label>
            <Input id="s-id" value={id} onChange={(e) => setId(e.target.value)} placeholder="ts-metrics" />
          </div>
        )}
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
      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : mode === "create" ? (
            <Plus className="h-4 w-4" />
          ) : (
            <Pencil className="h-4 w-4" />
          )}
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="secondary" disabled={saving} onClick={onCancel}>
            <X className="h-4 w-4" /> Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
