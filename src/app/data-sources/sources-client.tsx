"use client";

import * as React from "react";
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
  ListTree,
  Activity,
  ScrollText,
  FolderOpen,
  Upload,
} from "lucide-react";
import { SourceDraft, type SourceRecord, type SqlSourceDraft } from "@/lib/registry";
import { type SourceListing, sourceListing } from "@/lib/source-listing";
import { summarizeCatalogDiff } from "@/lib/catalog/refresh";
import { CatalogBrowserDialog } from "@/components/sources/catalog-browser";
import { RefreshCatalogDialog } from "@/components/sources/catalog-refresh";
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
import { RepairingNote } from "@/components/repairing-note";
import { useRepairingObject } from "@/components/use-repairing-object";
import { ModelChip, useModelChoice } from "@/components/model-chip";
import { FIRST_DASHBOARD_DOCS_URL } from "@/lib/onboarding";
import { apiErrorFromThrown, readApiError } from "@/lib/errors";
import { buildSourceDescriptionStarters } from "@/lib/prompts/starters";
import { availableUploads, isKindAvailable, isSqlSource } from "@/lib/sources/registry";
import { SourceForm } from "./source-form";
import {
  PrometheusSourceForm,
  type PrometheusSourceFormInitial,
} from "./prometheus-source-form";
import { ChoiceCard, ChoiceCardGroup } from "@/components/ui/choice-card";
import { LokiSourceForm, type LokiSourceFormInitial } from "./loki-source-form";
import { DuckDbSourceForm } from "./duckdb-source-form";
import type { KindAvailability, UploadAvailability } from "@/lib/sources/types";
import { type GrantedSecretRefsState, readinessIn } from "@/lib/secret-refs";
import { Notice } from "@/components/notice";
import { useReducedMotion } from "@/components/motion-preference";
import { animateOut } from "@/lib/motion";
import { SecretRefBadge, useGrantedSecretRefs } from "./secret-ref-status";
import {
  DeleteSourceDialog,
  ImpactCell,
  SourceImpactDialog,
  useSourceImpactMap,
} from "./source-impact";

/**
 * One row of the list. `record` is the full source and is present only for a
 * source admin: the list route sends anyone else the listing alone.
 */
type Row = SourceListing & { record?: SourceRecord };

export function SourcesClient({
  workspaces,
  manageable,
  startCreating = false,
  kinds = [],
}: {
  /** Every workspace the identity may see, the manageable ones first. */
  workspaces: string[];
  /** The workspaces where the identity is a source admin. */
  manageable: string[];
  /**
   * Open the Add source dialog on arrival. Set by `?new=1`, which is where the
   * first-run flow's "Connect a data source" step points: the step lands on the
   * form rather than on a page with a button to find.
   */
  startCreating?: boolean;
  /** Which kinds this server can hold (#573): a kind it cannot is not offered. */
  kinds?: KindAvailability[];
}) {
  // Workspace switching is hidden for now; pin to the first accessible workspace.
  const [workspaceId] = React.useState<string | null>(workspaces[0] ?? null);
  // Decides what is rendered, not what is allowed: every action's route checks
  // `source:manage` itself, and the list route decides what a row carries.
  const canManage = workspaceId !== null && manageable.includes(workspaceId);
  const [sources, setSources] = React.useState<Row[] | null>(null);
  const motion = !useReducedMotion();
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
  // The source whose catalog is open, and the one whose refresh is in review.
  const [browsing, setBrowsing] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState<string | null>(null);

  const load = React.useCallback(async (ws: string) => {
    const res = await fetch(`/api/sources?workspaceId=${encodeURIComponent(ws)}`);
    const body = await res.json();
    setSources(res.ok ? rowsFrom(body) : []);
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
      setSources(res.ok ? rowsFrom(body) : []);
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
    // A test records what the server is (#557), which the row shows.
    if (body?.ok === true && workspaceId) void load(workspaceId);
  }

  // A refresh is reviewed before it is written (#123), so the button opens the
  // diff rather than writing. The notice afterwards says what changed and
  // where the catalog now stands, because "catalog refreshed" said the same
  // thing whether a table had gone or not.
  function refreshed(id: string, diff: string, health: CatalogHealth) {
    const source = sources?.find((s) => s.id === id);
    setNotice(
      source && health.state !== "ok"
        ? `${diff} ${describeCatalogHealth(source, health)}`
        : `${source?.name ?? id}: ${diff}`,
    );
    if (workspaceId) void load(workspaceId);
  }

  async function remove(id: string) {
    setBusy(id);
    const res = await fetch(`/api/sources/${id}`, { method: "DELETE" });
    const body = await res.json();
    setNotice(res.ok ? `${id}: ${body.outcome}` : `${id}: delete failed`);
    setBusy(null);
    setConfirmingDelete(null);
    // The row leaves before the list reloads without it (#237). It is found
    // by the anchor id the row already carries for the command palette.
    const row = res.ok ? document.getElementById(`source-${id}`) : null;
    if (row) await animateOut(row, motion);
    if (workspaceId) void load(workspaceId);
  }

  // The refs this workspace may use, each with whether it resolves: the rows'
  // badges read it, so a source whose credentials have gone missing — or
  // whose grant was withdrawn — is visible here rather than the next time
  // someone opens a dashboard that depends on it, and the forms pick from it.
  // Both read admin-only routes, so a viewer does not ask.
  const secretRefs = useGrantedSecretRefs(canManage ? workspaceId : null);

  // What each source is used by, so the count is in the row before anyone
  // presses Delete rather than in an error after.
  const impact = useSourceImpactMap(
    canManage ? (sources ?? []).map((source) => source.id) : [],
  );

  if (workspaces.length === 0) {
    return (
      <div className="mx-auto w-full max-w-2xl">
        <Card>
          <CardContent className="text-sm text-muted">
            You need a role in a workspace to see its data sources.
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

  // Each kind has its own form; a source's kind is fixed once it exists.
  const editedRecord = sources?.find((source) => source.id === editing)?.record;
  // The SQL form is the database form; a DuckDB source has none yet (#573).
  const sourceBeingEdited =
    editedRecord && "host" in editedRecord.config
      ? { ...editedRecord, config: editedRecord.config }
      : undefined;
  const promBeingEdited =
    editedRecord && "metrics" in editedRecord.config
      ? { record: editedRecord, config: editedRecord.config }
      : undefined;
  const duckBeingEdited =
    editedRecord && "path" in editedRecord.config
      ? { record: editedRecord, config: editedRecord.config }
      : undefined;
  const lokiBeingEdited =
    editedRecord && "labels" in editedRecord.config
      ? { record: editedRecord, config: editedRecord.config }
      : undefined;
  const sourceShowingImpact = sources?.find((source) => source.id === showingImpact);
  const sourceBeingDeleted = sources?.find((source) => source.id === confirmingDelete);
  const sourceBeingBrowsed = sources?.find((source) => source.id === browsing) ?? null;
  const sourceBeingRefreshed =
    sources?.find((source) => source.id === refreshing) ?? null;

  return (
    <div className="space-y-6">
      {/* Workspace selector hidden for now; defaults to the first accessible
          workspace. Restore it among the actions to switch workspaces. */}
      <PageHeader
        title="Data sources"
        description={
          canManage
            ? "Manage the connections that dashboards and Explore query against. Sources are scoped to a workspace and referenced by stable IDs."
            : "The sources dashboards and Explore query against in this workspace. Browse a catalog to see the tables and columns you can query."
        }
        actions={
          canManage &&
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

      <Notice
        open={notice !== null}
        className="border border-border bg-surface px-3 py-2 text-sm text-muted"
      >
        {notice}
      </Notice>

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
      {canManage && nothingQueryable && (
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
            !canManage ? (
              "A source admin for this workspace adds them."
            ) : (
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
            )
          }
          action={
            canManage ? (
              <Button onClick={() => setCreating(true)}>Add source</Button>
            ) : undefined
          }
        />
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <TableHeader>Name</TableHeader>
              {canManage && <TableHeader>Endpoint</TableHeader>}
              <TableHeader>Schema</TableHeader>
              <TableHeader>Tables</TableHeader>
              <TableHeader>Catalog</TableHeader>
              {canManage && <TableHeader>Used by</TableHeader>}
              {canManage && <TableHeader>Credentials</TableHeader>}
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
                className="fade-in target-reveal scroll-mt-24 target:bg-surface-2"
              >
                <TableCell>
                  <div className="font-medium">{source.name}</div>
                  <div className="text-xs text-muted">
                    {source.id}
                    {"engine" in source && source.engine && ` · ${source.engine}`}
                  </div>
                </TableCell>
                {source.record && (
                  <TableCell className="whitespace-nowrap">
                    {"host" in source.record.config
                      ? `${source.record.config.host}:${source.record.config.port}/${source.record.config.database}`
                      : "url" in source.record.config
                        ? source.record.config.url
                        : source.record.config.path}
                  </TableCell>
                )}
                <TableCell>{"schema" in source ? source.schema : "—"}</TableCell>
                <TableCell>
                  {"tableCount" in source
                    ? source.tableCount
                    : "metricCount" in source
                      ? source.metricCount
                      : source.labelCount}
                </TableCell>
                <TableCell>
                  <CatalogHealthBadge source={source} health={catalog[source.id]} />
                </TableCell>
                {source.record && (
                  <TableCell>
                    <ImpactCell
                      state={impact[source.id]}
                      onOpen={() => setShowingImpact(source.id)}
                    />
                  </TableCell>
                )}
                {source.record && (
                  <TableCell>
                    {source.record.secretRef !== null && (
                      <SecretRefBadge
                        readiness={readinessIn(secretRefs, source.record.secretRef)}
                      />
                    )}
                  </TableCell>
                )}
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
                      onClick={() => {
                        setNotice(null);
                        setBrowsing(source.id);
                      }}
                    >
                      <ListTree className="h-4 w-4" /> Catalog
                      <span className="sr-only"> of {source.name}</span>
                    </Button>
                    {source.record && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          busy={busy === source.id}
                          onClick={() => test(source.id)}
                        >
                          <Plug className="h-4 w-4" /> Test
                          <span className="sr-only"> {source.name}</span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy === source.id}
                          onClick={() => {
                            setNotice(null);
                            setRefreshing(source.id);
                          }}
                        >
                          <RefreshCw className="h-4 w-4" /> Refresh
                          <span className="sr-only"> {source.name}</span>
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
                          <span className="sr-only"> {source.name}</span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy === source.id}
                          // Icon-only, so the name is the only thing a screen
                          // reader has; it says which source (#77).
                          aria-label={`Delete ${source.name}`}
                          title={`Delete ${source.name}`}
                          onClick={() => {
                            setNotice(null);
                            setConfirmingDelete(source.id);
                          }}
                        >
                          <Trash2 className="h-4 w-4 text-danger" />
                        </Button>
                      </>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <CatalogBrowserDialog
        source={sourceBeingBrowsed}
        onClose={() => setBrowsing(null)}
        onChanged={(id, health) => setCatalog((prev) => ({ ...prev, [id]: health }))}
      />

      <RefreshCatalogDialog
        source={sourceBeingRefreshed}
        onClose={() => setRefreshing(null)}
        onApplied={({ diff, catalogHealth }) => {
          const id = refreshing;
          setRefreshing(null);
          if (id) refreshed(id, summarizeCatalogDiff(diff), catalogHealth);
        }}
      />

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

      {workspaceId && canManage && (
        <Dialog open={creating} onOpenChange={setCreating} title="Add source">
          <CreateSourcePanel
            key={`create-${workspaceId}`}
            workspaceId={workspaceId}
            existing={(sources ?? []).flatMap((row) => (row.record ? [row.record] : []))}
            secretRefs={secretRefs}
            duckdbAvailable={isKindAvailable(kinds, "duckdb")}
            uploads={availableUploads(kinds, "duckdb")}
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
            secretRefs={secretRefs}
            initial={{
              name: sourceBeingEdited.name,
              secretRef: sourceBeingEdited.secretRef ?? undefined,
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

      {promBeingEdited && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          title={`Edit ${promBeingEdited.record.name}`}
        >
          <PrometheusSourceForm
            mode="edit"
            workspaceId={promBeingEdited.record.workspaceId}
            secretRefs={secretRefs}
            initial={{
              name: promBeingEdited.record.name,
              secretRef: promBeingEdited.record.secretRef,
              config: promBeingEdited.config,
            }}
            submitLabel="Save changes"
            onSubmit={async ({ name, secretRef, config }) => {
              const res = await fetch(`/api/sources/${promBeingEdited.record.id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, secretRef, config }),
              });
              if (!res.ok) return readApiError(res);
              setEditing(null);
              setNotice(`${promBeingEdited.record.id}: updated`);
              if (workspaceId) void load(workspaceId);
              return null;
            }}
            onCancel={() => setEditing(null)}
          />
        </Dialog>
      )}

      {lokiBeingEdited && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          title={`Edit ${lokiBeingEdited.record.name}`}
        >
          <LokiSourceForm
            mode="edit"
            workspaceId={lokiBeingEdited.record.workspaceId}
            secretRefs={secretRefs}
            initial={{
              name: lokiBeingEdited.record.name,
              secretRef: lokiBeingEdited.record.secretRef,
              config: lokiBeingEdited.config,
            }}
            submitLabel="Save changes"
            onSubmit={async ({ name, secretRef, config }) => {
              const res = await fetch(`/api/sources/${lokiBeingEdited.record.id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, secretRef, config }),
              });
              if (!res.ok) return readApiError(res);
              setEditing(null);
              setNotice(`${lokiBeingEdited.record.id}: updated`);
              if (workspaceId) void load(workspaceId);
              return null;
            }}
            onCancel={() => setEditing(null)}
          />
        </Dialog>
      )}

      {duckBeingEdited && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          title={`Edit ${duckBeingEdited.record.name}`}
        >
          <DuckDbSourceForm
            mode="edit"
            workspaceId={duckBeingEdited.record.workspaceId}
            initial={{
              name: duckBeingEdited.record.name,
              config: duckBeingEdited.config,
            }}
            submitLabel="Save changes"
            onSubmit={async ({ name, config }) => {
              const res = await fetch(`/api/sources/${duckBeingEdited.record.id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, config }),
              });
              if (!res.ok) return readApiError(res);
              setEditing(null);
              setNotice(`${duckBeingEdited.record.id}: updated`);
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
 * What the manual form creates, by the language its panels are written in,
 * and `files` for DuckDB (#573): SQL too, but its own form, a path in place
 * of a connection. `upload` is the same DuckDB form with files from the
 * browser in place of the path (#595).
 */
type FormLanguage = "sql" | "promql" | "logql" | "files" | "upload";

/**
 * The kind picker's cards: one per kind the form can create, each pictured
 * by a line of the language its panels carry.
 */
const KIND_CHOICES: {
  value: FormLanguage;
  label: string;
  description: string;
  Icon: typeof Database;
  sample: string;
}[] = [
  {
    value: "sql",
    label: "TimescaleDB (SQL)",
    description: "Tables in TimescaleDB or PostgreSQL.",
    Icon: Database,
    sample: "SELECT time_bucket('1m', ts) …",
  },
  {
    value: "promql",
    label: "Prometheus (PromQL)",
    description: "Metrics from Prometheus, Thanos, Mimir or VictoriaMetrics.",
    Icon: Activity,
    sample: "rate(http_requests_total[5m])",
  },
  {
    value: "logql",
    label: "Loki (LogQL)",
    description: "Log streams from Grafana Loki or Grafana Cloud Logs.",
    Icon: ScrollText,
    sample: '{app="api"} |= "error"',
  },
  {
    value: "files",
    label: "DuckDB (files)",
    description: "Parquet, CSV and JSON files, or a .duckdb file, on the server.",
    Icon: FolderOpen,
    sample: "SELECT time_bucket(INTERVAL '1m', ts) …",
  },
  {
    value: "upload",
    label: "Upload files",
    description: "CSV and JSON files from your computer, read with DuckDB.",
    Icon: Upload,
    sample: "SELECT category, sum(amount) …",
  },
];

/**
 * The "Add source" body: an optional natural-language drafter that seeds the
 * manual form below it. The model only ever drafts the safe config for review —
 * creation still goes through the same guarded POST /api/sources.
 */
function CreateSourcePanel({
  workspaceId,
  existing,
  secretRefs,
  duckdbAvailable = false,
  uploads = null,
  onCreated,
  onCancel,
}: {
  workspaceId: string;
  /** The workspace's current sources, which the drafter's examples are drawn from. */
  existing: SourceRecord[];
  /** The refs the workspace may use, for the form's picker. */
  secretRefs: GrantedSecretRefsState;
  /** Offer DuckDB (#573): the server has the binding and `DUCKDB_SOURCES_DIR`. */
  duckdbAvailable?: boolean;
  /** Offer "Upload files" (#595): the server can write uploads, within these bounds. */
  uploads?: UploadAvailability | null;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [seed, setSeed] = React.useState<SqlSourceDraft>();
  const [promSeed, setPromSeed] = React.useState<PrometheusSourceFormInitial>();
  const [lokiSeed, setLokiSeed] = React.useState<LokiSourceFormInitial>();
  // Which kind of source the manual form creates; a draft decides it too.
  const [chosen, setChosen] = React.useState<FormLanguage>("sql");
  // DuckDB is offered only where the server can hold it, and never drafted:
  // its path is the operator's to pick (#573).
  const choices = KIND_CHOICES.filter(
    (c) =>
      (c.value !== "files" || duckdbAvailable) &&
      (c.value !== "upload" || uploads !== null),
  );
  // Bumped on each draft so the form remounts and re-seeds from the new values.
  const [seedSeq, setSeedSeq] = React.useState(0);
  // The configuration form stays hidden until the drafter returns a result;
  // an explicit opt-in lets users skip the model and fill it in by hand.
  const [manual, setManual] = React.useState(false);
  const showForm =
    seed !== undefined || promSeed !== undefined || lokiSeed !== undefined || manual;

  return (
    <div className="space-y-4">
      <NaturalLanguageDrafter
        workspaceId={workspaceId}
        existing={existing}
        onDraft={(draft) => {
          if ("sql" in draft) {
            setSeed(draft.sql);
            setChosen("sql");
          } else if ("prometheus" in draft) {
            setPromSeed(draft.prometheus);
            setChosen("promql");
          } else {
            setLokiSeed(draft.loki);
            setChosen("logql");
          }
          setSeedSeq((n) => n + 1);
        }}
      />
      {showForm ? (
        <div className="space-y-4 border-t border-border pt-4">
          <div className="space-y-2">
            <div>
              <h3 id="s-kind" className="text-sm font-medium">
                Kind
              </h3>
              <p id="s-kind-hint" className="text-xs text-muted">
                What the source reads, and so the language its panels are written in. A
                source&rsquo;s kind is fixed once it is saved.
              </p>
            </div>
            <ChoiceCardGroup
              value={chosen}
              onValueChange={setChosen}
              labelledBy="s-kind"
              describedBy="s-kind-hint"
              className={choices.length > 3 ? "sm:grid-cols-2" : "sm:grid-cols-3"}
            >
              {choices.map(({ value, label, description, Icon, sample }) => (
                <ChoiceCard
                  key={value}
                  value={value}
                  label={
                    <>
                      <Icon className="h-4 w-4" aria-hidden /> {label}
                    </>
                  }
                  description={description}
                >
                  <span className="block truncate rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-xs text-muted">
                    {sample}
                  </span>
                </ChoiceCard>
              ))}
            </ChoiceCardGroup>
          </div>
          {chosen === "files" || chosen === "upload" ? (
            <DuckDbSourceForm
              key={chosen}
              upload={chosen === "upload" ? (uploads ?? undefined) : undefined}
              mode="create"
              workspaceId={workspaceId}
              submitLabel="Create source"
              onSubmit={async ({ id, name, config }) => {
                const res = await fetch("/api/sources", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ workspaceId, id, name, config }),
                });
                if (!res.ok) return readApiError(res);
                onCreated();
                return null;
              }}
              onCancel={onCancel}
            />
          ) : chosen === "logql" ? (
            <LokiSourceForm
              key={`l${seedSeq}`}
              mode="create"
              workspaceId={workspaceId}
              secretRefs={secretRefs}
              submitLabel="Create source"
              initial={lokiSeed}
              onSubmit={async ({ id, name, secretRef, config }) => {
                const res = await fetch("/api/sources", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    workspaceId,
                    id,
                    name,
                    ...(secretRef ? { secretRef } : {}),
                    config,
                  }),
                });
                if (!res.ok) return readApiError(res);
                onCreated();
                return null;
              }}
              onCancel={onCancel}
            />
          ) : chosen === "promql" ? (
            <PrometheusSourceForm
              key={`p${seedSeq}`}
              mode="create"
              workspaceId={workspaceId}
              secretRefs={secretRefs}
              submitLabel="Create source"
              initial={promSeed}
              onSubmit={async ({ id, name, secretRef, config }) => {
                const res = await fetch("/api/sources", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    workspaceId,
                    id,
                    name,
                    ...(secretRef ? { secretRef } : {}),
                    config,
                  }),
                });
                if (!res.ok) return readApiError(res);
                onCreated();
                return null;
              }}
              onCancel={onCancel}
            />
          ) : (
            <SourceForm
              key={seedSeq}
              mode="create"
              workspaceId={workspaceId}
              secretRefs={secretRefs}
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
          )}
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
  onDraft: (
    draft:
      | { sql: SqlSourceDraft }
      | { prometheus: PrometheusSourceFormInitial }
      | { loki: LokiSourceFormInitial },
  ) => void;
}) {
  const [description, setDescription] = React.useState("");
  // There is no catalog to read here — this is how a source comes to exist —
  // so the examples are drawn from the sources the workspace already has, and
  // fall back to the shape of a description when there are none.
  const presets = React.useMemo(
    () => buildSourceDescriptionStarters(existing.filter(isSqlSource)),
    [existing],
  );
  const { object, submit, isLoading, error, stop, repairing } = useRepairingObject({
    api: "/api/sources/generate",
    schema: SourceDraft,
    onFinish({ object }) {
      // The model drafts SQL sources only (#386 adds Prometheus).
      if (!object) return;
      if ("host" in object.config && object.secretRef) {
        onDraft({
          sql: { ...object, config: object.config, secretRef: object.secretRef },
        });
      } else if ("metrics" in object.config) {
        onDraft({
          prometheus: {
            id: object.id,
            name: object.name,
            secretRef: object.secretRef ?? null,
            config: object.config,
          },
        });
      } else if ("labels" in object.config) {
        onDraft({
          loki: {
            id: object.id,
            name: object.name,
            secretRef: object.secretRef ?? null,
            config: object.config,
          },
        });
      }
    },
  });

  // The model chip (#442): the drafting model, the person's pick or the default.
  const choice = useModelChoice(workspaceId);

  function draft() {
    if (isLoading || !description.trim()) return;
    submit({
      workspaceId,
      prompt: description,
      ...(choice.modelId ? { modelId: choice.modelId } : {}),
    });
  }

  return (
    <div className="space-y-2">
      <Label htmlFor="nl-source">Describe the source</Label>
      <p className="text-xs text-muted">
        Draft the connection and table catalog from plain English. Never include passwords
        — credentials come from a <code>secret_ref</code> granted to this workspace. The
        draft fills in the form below for you to review, adjust, and create.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <ModelChip choice={choice} disabled={isLoading} />
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
          busy={isLoading}
          disabled={!description.trim()}
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
      <RepairingNote show={repairing} />
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

/**
 * The list route's answer as rows. A source admin gets full records, and the
 * listing is derived from each; anyone else gets the listing alone.
 */
function rowsFrom(body: { canManage?: boolean; sources?: unknown[] }): Row[] {
  const sources = body.sources ?? [];
  return body.canManage
    ? (sources as SourceRecord[]).map((record) => ({ ...sourceListing(record), record }))
    : (sources as SourceListing[]);
}
