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
  SendHorizontal,
  Database,
  ExternalLink,
} from "lucide-react";
import { SourceDraft, type SourceRecord } from "@/lib/registry";
import { type CatalogHealth, describeCatalogHealth } from "@/lib/catalog/health";
import { CatalogHealthBadge } from "@/components/sources/catalog-health";
import { SourceTestReport } from "@/components/sources/SourceTestReport";
import type { SourceTestResult } from "@/lib/source-test";
import { Button, ButtonLabel } from "@/components/ui/button";
import { Textarea, Label } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Dialog } from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ErrorDisplay } from "@/components/ui/error-display";
import { FIRST_DASHBOARD_DOCS_URL } from "@/lib/onboarding";
import { apiErrorFromThrown, readApiError } from "@/lib/errors";
import { buildSourceDescriptionStarters } from "@/lib/prompts/starters";
import { SourceForm } from "./source-form";
import { SecretRefBadge, useSecretRefReadinessMap } from "./secret-ref-status";
import {
  DeleteSourceDialog,
  ImpactCell,
  SourceImpactDialog,
  useSourceImpactMap,
} from "./source-impact";

export function SourcesClient({
  workspaces,
  startCreating = false,
}: {
  workspaces: string[];
  /**
   * Open the Add source dialog on arrival. Set by `?new=1`, which is where the
   * first-run flow's "Connect a data source" step points: the step lands on the
   * form rather than on a page with a button to find.
   */
  startCreating?: boolean;
}) {
  // Workspace switching is hidden for now; pin to the first accessible workspace.
  const [workspaceId] = React.useState<string | null>(workspaces[0] ?? null);
  const [sources, setSources] = React.useState<SourceRecord[] | null>(null);
  // Decided by the server (the staleness threshold is an environment setting),
  // keyed by source id, and replaced wholesale on every reload.
  const [catalog, setCatalog] = React.useState<Record<string, CatalogHealth>>({});
  const [busy, setBusy] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(startCreating);
  const [notice, setNotice] = React.useState<string | null>(null);
  // The test's answer is a structure now, not a sentence, so it gets its own
  // state rather than being flattened into the notice line (#126).
  const [testResult, setTestResult] = React.useState<{
    sourceId: string;
    sourceName: string;
    result: SourceTestResult;
  } | null>(null);
  // The source whose impact is on screen, and the one awaiting a delete
  // confirmation; both are ids so a reload cannot leave a stale copy open.
  const [showingImpact, setShowingImpact] = React.useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = React.useState<string | null>(null);

  const load = React.useCallback(async (ws: string) => {
    const res = await fetch(`/api/sources?workspaceId=${encodeURIComponent(ws)}`);
    const body = await res.json();
    setSources(res.ok ? body.sources : []);
    setCatalog(res.ok ? (body.catalogHealth ?? {}) : {});
  }, []);

  React.useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    void (async () => {
      const res = await fetch(
        `/api/sources?workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      const body = await res.json();
      if (!active) return;
      setSources(res.ok ? body.sources : []);
      setCatalog(res.ok ? (body.catalogHealth ?? {}) : {});
    })();
    return () => {
      active = false;
    };
  }, [workspaceId]);

  async function test(id: string) {
    setBusy(id);
    setNotice(null);
    const res = await fetch(`/api/sources/${id}/test`, { method: "POST" });
    const body = await res.json().catch(() => null);
    const source = sources?.find((s) => s.id === id);
    if (body && typeof body.message === "string") {
      setTestResult({
        sourceId: id,
        sourceName: source?.name ?? id,
        // The route answers with the whole result on success and on a failed
        // connection alike; a transport failure is the only case with nothing
        // to render, and it falls through to the notice below.
        result: body as SourceTestResult,
      });
    } else {
      setTestResult(null);
      setNotice(`${id}: test failed`);
    }
    setBusy(null);
  }

  // A refresh reports what it found, not merely that it ran: a table the
  // database no longer has is the whole reason to press this button, and the
  // old "catalog refreshed" said the same thing whether one had gone or not.
  async function refresh(id: string) {
    setBusy(id);
    const res = await fetch(`/api/sources/${id}/refresh`, { method: "POST" });
    const body = await res.json().catch(() => null);
    const health: CatalogHealth | undefined = body?.catalogHealth;
    const source = sources?.find((s) => s.id === id);
    setNotice(
      !res.ok
        ? `${id}: refresh failed`
        : health && source
          ? describeCatalogHealth(source, health)
          : `${id}: catalog refreshed`,
    );
    setBusy(null);
    if (workspaceId) void load(workspaceId);
  }

  async function remove(id: string) {
    setBusy(id);
    const res = await fetch(`/api/sources/${id}`, { method: "DELETE" });
    const body = await res.json();
    setNotice(res.ok ? `${id}: ${body.outcome}` : `${id}: delete failed`);
    setBusy(null);
    setConfirmingDelete(null);
    if (workspaceId) void load(workspaceId);
  }

  // Readiness for the refs the listed sources name, so a source whose
  // credentials have gone missing is visible here rather than the next time
  // someone opens a dashboard that depends on it.
  const readiness = useSecretRefReadinessMap(
    workspaceId,
    (sources ?? []).map((source) => source.secretRef),
  );

  // What each source is used by, so the count is in the row before anyone
  // presses Delete rather than in an error after.
  const impact = useSourceImpactMap((sources ?? []).map((source) => source.id));

  if (workspaces.length === 0) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card>
          <CardContent className="text-sm text-muted">
            You need the <code>source-admin</code> role in a workspace to manage data
            sources.
          </CardContent>
        </Card>
      </div>
    );
  }

  // True only once the health of every listed source is known, so the hint
  // does not appear and then vanish while the list is still loading.
  const nothingQueryable =
    sources !== null &&
    sources.length > 0 &&
    sources.every((source) => catalog[source.id]?.blocked === true);

  const sourceBeingEdited = sources?.find((source) => source.id === editing);
  const sourceShowingImpact = sources?.find((source) => source.id === showingImpact);
  const sourceBeingDeleted = sources?.find((source) => source.id === confirmingDelete);

  return (
    <div className="space-y-6">
      {/* Workspace selector hidden for now; defaults to the first accessible
          workspace. Restore it among the actions to switch workspaces. */}
      <PageHeader
        title="Data sources"
        description="Manage the connections that dashboards and Explore query against. Sources are scoped to a workspace and referenced by stable IDs."
        actions={
          sources !== null && (
            <Button
              collapse
              title="Add source"
              onClick={() => {
                setNotice(null);
                setCreating(true);
              }}
            >
              <Plus className="h-4 w-4" /> <ButtonLabel>Add source</ButtonLabel>
            </Button>
          )
        }
      />

      {notice && (
        <div className="border border-border bg-surface px-3 py-2 text-sm text-muted">
          {notice}
        </div>
      )}

      {testResult && (
        <SourceTestReport
          sourceName={testResult.sourceName}
          result={testResult.result}
          onDismiss={() => setTestResult(null)}
        />
      )}

      {/*
        Every source here is still unusable: registering one is only half the
        job, and the half that is left is two buttons in the row below. Said
        once for the whole list rather than per row, and gone the moment any
        source becomes queryable.
      */}
      {nothingQueryable && (
        <div className="border border-warning/40 bg-surface px-3 py-2 text-sm text-muted">
          Next: press <span className="text-foreground">Test</span> to check the
          credentials resolve, then <span className="text-foreground">Refresh</span> to
          read the tables and columns. Until a refresh has run, generating against this
          source is refused.
        </div>
      )}

      {sources === null ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : sources.length === 0 ? (
        <EmptyState
          icon={<Database className="h-6 w-6" />}
          title="No sources in this workspace yet"
          description={
            <>
              A source names the database, the schema and the tables Holotable may read.
              Its credentials stay in the server environment under a secret reference —
              they are never stored here.{" "}
              <a
                href={FIRST_DASHBOARD_DOCS_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-foreground underline underline-offset-2"
              >
                The walkthrough <ExternalLink className="h-3 w-3" />
              </a>{" "}
              has the whole sequence.
            </>
          }
          action={<Button onClick={() => setCreating(true)}>Add source</Button>}
        />
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <TableHeader>Name</TableHeader>
              <TableHeader>Endpoint</TableHeader>
              <TableHeader>Schema</TableHeader>
              <TableHeader>Tables</TableHeader>
              <TableHeader>Catalog</TableHeader>
              <TableHeader>Used by</TableHeader>
              <TableHeader>Credentials</TableHeader>
              <TableHeader>Status</TableHeader>
              <TableHeader className="text-right">Actions</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {sources.map((source) => (
              // The id doubles as the anchor the command palette links to
              // (`/data-sources#source-<id>`): there is no per-source route,
              // and a browser scrolling to a row needs nothing but this.
              <TableRow
                key={source.id}
                id={`source-${source.id}`}
                className="scroll-mt-24 target:bg-surface-2"
              >
                <TableCell>
                  <div className="font-medium">{source.name}</div>
                  <div className="text-xs text-muted">{source.id}</div>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {source.config.host}:{source.config.port}/{source.config.database}
                </TableCell>
                <TableCell>{source.config.schema}</TableCell>
                <TableCell>{source.config.tables.length}</TableCell>
                <TableCell>
                  <CatalogHealthBadge source={source} health={catalog[source.id]} />
                </TableCell>
                <TableCell>
                  <ImpactCell
                    state={impact[source.id]}
                    onOpen={() => setShowingImpact(source.id)}
                  />
                </TableCell>
                <TableCell>
                  <SecretRefBadge
                    readiness={readiness[source.secretRef] ?? { state: "checking" }}
                  />
                </TableCell>
                <TableCell>
                  {source.tombstonedAt ? (
                    <span className="text-danger">Tombstoned</span>
                  ) : (
                    "Active"
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy === source.id}
                      onClick={() => test(source.id)}
                    >
                      <Plug className="h-4 w-4" /> Test
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy === source.id}
                      onClick={() => refresh(source.id)}
                    >
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
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy === source.id}
                      onClick={() => {
                        setNotice(null);
                        setConfirmingDelete(source.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-danger" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {sourceShowingImpact && (
        <SourceImpactDialog
          name={sourceShowingImpact.name}
          state={impact[sourceShowingImpact.id]}
          onClose={() => setShowingImpact(null)}
        />
      )}

      {sourceBeingDeleted && (
        <DeleteSourceDialog
          name={sourceBeingDeleted.name}
          state={impact[sourceBeingDeleted.id]}
          busy={busy === sourceBeingDeleted.id}
          onConfirm={() => void remove(sourceBeingDeleted.id)}
          onCancel={() => setConfirmingDelete(null)}
        />
      )}

      {workspaceId && (
        <Dialog open={creating} onOpenChange={setCreating} title="Add source">
          <CreateSourcePanel
            key={`create-${workspaceId}`}
            workspaceId={workspaceId}
            existing={sources ?? []}
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
            workspaceId={sourceBeingEdited.workspaceId}
            initial={{
              name: sourceBeingEdited.name,
              secretRef: sourceBeingEdited.secretRef,
              config: sourceBeingEdited.config,
            }}
            submitLabel="Save changes"
            onSubmit={async ({ name, secretRef, config }) => {
              const res = await fetch(`/api/sources/${sourceBeingEdited.id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, secretRef, config }),
              });
              if (!res.ok) return readApiError(res);
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
  existing,
  onCreated,
  onCancel,
}: {
  workspaceId: string;
  /** The workspace's current sources, which the drafter's examples are drawn from. */
  existing: SourceRecord[];
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [seed, setSeed] = React.useState<SourceDraft>();
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
        existing={existing}
        onDraft={(draft) => {
          setSeed(draft);
          setSeedSeq((n) => n + 1);
        }}
      />
      {showForm ? (
        <div className="border-t border-border pt-4">
          <SourceForm
            key={seedSeq}
            mode="create"
            workspaceId={workspaceId}
            submitLabel="Create source"
            initial={seed}
            onSubmit={async ({ id, name, secretRef, config }) => {
              const res = await fetch("/api/sources", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ workspaceId, id, name, secretRef, config }),
              });
              if (!res.ok) return readApiError(res);
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
  existing,
  onDraft,
}: {
  workspaceId: string;
  existing: SourceRecord[];
  onDraft: (draft: SourceDraft) => void;
}) {
  const [description, setDescription] = React.useState("");
  // There is no catalog to read here — this is how a source comes to exist —
  // so the examples are drawn from the sources the workspace already has, and
  // fall back to the shape of a description when there are none.
  const presets = React.useMemo(
    () => buildSourceDescriptionStarters(existing),
    [existing],
  );
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
        Draft the connection and table catalog from plain English. Never include passwords
        — credentials come from the <code>secret_ref</code> environment family. The draft
        fills in the form below for you to review, adjust, and create.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {presets.map((preset) => (
          <button
            key={preset}
            type="button"
            disabled={isLoading}
            onClick={() => setDescription(preset)}
            title={preset}
            className="max-w-full truncate border border-border bg-surface px-3 py-1 text-xs text-muted transition-colors hover:border-primary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
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
          placeholder={
            presets[0]
              ? `e.g. ${presets[0]}`
              : "Describe the database and the tables to track"
          }
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
        <ErrorDisplay
          error={apiErrorFromThrown(error)}
          onRetry={draft}
          retryLabel="Try again"
          disabled={isLoading}
        />
      )}
      {isLoading && object && (
        <pre className="max-h-40 overflow-auto border border-border bg-surface p-3 text-xs text-muted">
          {JSON.stringify(object, null, 2)}
        </pre>
      )}
    </div>
  );
}
