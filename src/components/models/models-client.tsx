"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Cpu, FlaskConical, Pencil, Plus, RefreshCw, Star, Trash2 } from "lucide-react";
import { ModelDialog, type ModelDialogTarget } from "@/components/models/model-dialog";
import { useReducedMotion } from "@/components/motion-preference";
import { LocalTime } from "@/components/time-display";
import { useFlip } from "@/components/use-flip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  CatalogModelRow,
  DetectedModelsSection,
  ModelConfigInput,
  ModelsPageData,
  ModelView,
  ServerModelRow,
  WorkspaceModelsSection,
} from "@/lib/ai/model-config";
import type { ModelTestResult } from "@/lib/ai/model-test-result";
import { providerKind } from "@/lib/ai/providers/registry";
import { apiErrorFromThrown, readApiError } from "@/lib/errors";
import { animateOut } from "@/lib/motion";

const providerLabel = (name: string) => providerKind(name)?.label ?? name;

type DialogState = {
  target: ModelDialogTarget;
  initial: ModelView | null;
  defaultName?: string;
} | null;

type DeleteState = { url: string; rowId: string; name: string } | null;

/** One row's test, saved credentials included, and what came back. */
type TestState = Record<string, { busy: boolean; message?: string; ok?: boolean }>;

function workspaceTarget(workspaceId: string): ModelDialogTarget {
  const url = `/api/workspaces/${encodeURIComponent(workspaceId)}/models`;
  return {
    url,
    testUrl: (id) => (id ? `${url}/${encodeURIComponent(id)}/test` : `${url}/test`),
    testBody: (input) => input,
    discoverBody: (config, id) => ({
      owner: "workspace",
      workspaceId,
      config,
      ...(id ? { modelId: id } : {}),
    }),
  };
}

function personalTarget(testWorkspace: string | null): ModelDialogTarget {
  return {
    url: "/api/me/models",
    testUrl: () => (testWorkspace ? "/api/me/models/test" : null),
    testBody: (config, id) => ({
      config,
      workspaceId: testWorkspace,
      ...(id ? { modelId: id } : {}),
    }),
    discoverBody: testWorkspace
      ? (config, id) => ({
          owner: "personal",
          workspaceId: testWorkspace,
          config,
          ...(id ? { modelId: id } : {}),
        })
      : null,
  };
}

/**
 * The Models page (#441): every model the caller can use or manage, in three
 * sections. The server's are read-only; a workspace's are editable by its
 * source-admins; the caller's own are theirs. Every change goes through the
 * catalog routes, which check `can()` again, and the page re-reads the
 * server's answer after it.
 */
export function ModelsClient({ data }: { data: ModelsPageData }) {
  const router = useRouter();
  const motion = !useReducedMotion();
  const [dialog, setDialog] = React.useState<DialogState>(null);
  const [deleting, setDeleting] = React.useState<DeleteState>(null);
  const [tests, setTests] = React.useState<TestState>({});
  const [notice, setNotice] = React.useState<string | null>(null);
  const testWorkspace = data.personalAppliesIn[0] ?? null;

  async function runTest(
    rowId: string,
    target: ModelDialogTarget,
    view: ModelView,
  ): Promise<void> {
    const url = target.testUrl(view.id);
    if (!url) return;
    setTests((t) => ({ ...t, [rowId]: { busy: true } }));
    const input: ModelConfigInput = { settings: view.settings };
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target.testBody(input, view.id)),
      });
      if (!res.ok) {
        const message = (await readApiError(res)).error;
        setTests((t) => ({ ...t, [rowId]: { busy: false, ok: false, message } }));
        return;
      }
      const result = (await res.json()) as ModelTestResult;
      setTests((t) => ({
        ...t,
        [rowId]: result.ok
          ? {
              busy: false,
              ok: true,
              message: `${view.name}: ${result.model || view.settings.model} answered in ${result.latencyMs} ms.`,
            }
          : { busy: false, ok: false, message: `${view.name}: ${result.message}` },
      }));
    } catch (err) {
      setTests((t) => ({
        ...t,
        [rowId]: { busy: false, ok: false, message: apiErrorFromThrown(err).error },
      }));
    }
  }

  async function remove(target: NonNullable<DeleteState>) {
    const res = await fetch(target.url, { method: "DELETE" });
    if (!res.ok) {
      setNotice((await readApiError(res)).error);
      return;
    }
    // The row leaves before the list re-reads without it.
    const row = document.getElementById(target.rowId);
    if (row) await animateOut(row, motion);
    setNotice(`${target.name} deleted.`);
    router.refresh();
  }

  async function saveWorkspace(
    section: WorkspaceModelsSection,
    patch: { defaultModel?: string | null; allowPersonalKeys?: boolean },
  ) {
    const res = await fetch(
      `/api/workspaces/${encodeURIComponent(section.workspaceId)}/model`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultModel: section.defaultModel,
          allowPersonalKeys: section.allowPersonalKeys,
          ...patch,
        }),
      },
    );
    setNotice(
      res.ok ? "Saved. The next generation uses it." : (await readApiError(res)).error,
    );
    if (res.ok) router.refresh();
  }

  const rowActions = (
    rowId: string,
    row: CatalogModelRow,
    target: ModelDialogTarget,
    extra?: React.ReactNode,
  ) =>
    row.view && (
      <div className="flex justify-end gap-1">
        {extra}
        <Button
          variant="ghost"
          size="sm"
          busy={tests[rowId]?.busy}
          disabled={target.testUrl(row.id) === null}
          title={
            target.testUrl(row.id) === null
              ? "Personal models can be tested once a workspace allows them."
              : undefined
          }
          onClick={() => row.view && void runTest(rowId, target, row.view)}
        >
          <FlaskConical className="h-4 w-4" /> Test
          <span className="sr-only"> {row.name}</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setDialog({ target, initial: row.view })}
        >
          <Pencil className="h-4 w-4" /> Edit
          <span className="sr-only"> {row.name}</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Delete ${row.name}`}
          title={`Delete ${row.name}`}
          onClick={() =>
            setDeleting({
              url: `${target.url}/${encodeURIComponent(row.id)}`,
              rowId,
              name: row.name,
            })
          }
        >
          <Trash2 className="h-4 w-4 text-danger" />
        </Button>
      </div>
    );

  const testNotes = (rows: CatalogModelRow[], prefix: string) =>
    rows.map((row) => {
      const state = tests[`${prefix}-${row.id}`];
      return state?.message ? (
        <p
          key={row.id}
          className={
            state.ok ? "fade-in text-xs text-success" : "fade-in text-xs text-danger"
          }
        >
          {state.message}
        </p>
      ) : null;
    });

  return (
    <div className="w-full space-y-6">
      <PageHeader
        title="Models"
        description="The models generation, Explore and chat can use: the server's, each workspace's, and your own."
      />
      <p role="status" className="text-sm">
        {notice && <span className="fade-in text-muted">{notice}</span>}
      </p>

      <ServerCard rows={data.server} demo={data.demo} />

      {data.detected && (
        <DetectedCard
          section={data.detected}
          onScanned={(message, ok) => {
            setNotice(message);
            if (ok) router.refresh();
          }}
        />
      )}

      {data.workspaces.map((section) => {
        const target = workspaceTarget(section.workspaceId);
        const prefix = `ws-${section.workspaceId}`;
        return (
          <Card key={section.workspaceId}>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <CardTitle>
                  Workspace <span className="font-mono">{section.workspaceId}</span>
                </CardTitle>
                <p className="text-xs text-muted">
                  When nobody picks, generations here use{" "}
                  <span className="text-foreground">
                    {defaultLabel(section, data.server)}
                  </span>
                  .
                </p>
              </div>
              {section.canManage && (
                <Button size="sm" onClick={() => setDialog({ target, initial: null })}>
                  <Plus className="h-4 w-4" /> Add model
                  <span className="sr-only"> to {section.workspaceId}</span>
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              <ModelTable
                rows={section.models}
                prefix={prefix}
                motion={motion}
                empty={
                  section.canManage
                    ? "No workspace models yet. Add one, or generations use the server's."
                    : "No workspace models; generations here use the server's."
                }
                defaultId={section.defaultModel}
                actions={(row, rowId) =>
                  section.canManage &&
                  rowActions(
                    rowId,
                    row,
                    target,
                    section.defaultModel !== row.id && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          void saveWorkspace(section, { defaultModel: row.id })
                        }
                      >
                        <Star className="h-4 w-4" /> Set as default
                        <span className="sr-only">
                          {" "}
                          for {section.workspaceId}: {row.name}
                        </span>
                      </Button>
                    ),
                  )
                }
              />
              {testNotes(section.models, prefix)}
              {section.canManage ? (
                <div className="flex flex-wrap items-center gap-4 border-t border-border pt-4">
                  {section.defaultModel !== null && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void saveWorkspace(section, { defaultModel: null })}
                    >
                      Use the server&apos;s default
                    </Button>
                  )}
                  <Checkbox
                    checked={section.allowPersonalKeys}
                    onCheckedChange={(allowPersonalKeys) =>
                      void saveWorkspace(section, { allowPersonalKeys })
                    }
                    label="Let people use their own models here"
                  />
                </div>
              ) : (
                <p className="text-xs text-muted">
                  {section.allowPersonalKeys
                    ? "Your own models can be used here."
                    : "This workspace does not allow personal models."}
                </p>
              )}
            </CardContent>
          </Card>
        );
      })}

      {data.personal && (
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle>Yours</CardTitle>
              <p className="text-xs text-muted">
                {data.personalAppliesIn.length > 0
                  ? `Usable in ${data.personalAppliesIn.join(", ")}, billed to you. Credentials are encrypted at rest and never shown again.`
                  : "No workspace you generate in allows personal models yet; a source-admin turns it on here."}
              </p>
            </div>
            <Button
              size="sm"
              onClick={() =>
                setDialog({ target: personalTarget(testWorkspace), initial: null })
              }
            >
              <Plus className="h-4 w-4" /> Add model
              <span className="sr-only"> of your own</span>
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            <ModelTable
              rows={data.personal}
              prefix="mine"
              motion={motion}
              empty="You have no models of your own."
              defaultId={null}
              actions={(row, rowId) =>
                rowActions(rowId, row, personalTarget(testWorkspace))
              }
            />
            {testNotes(data.personal, "mine")}
          </CardContent>
        </Card>
      )}

      {dialog && (
        <ModelDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          initial={dialog.initial}
          defaultName={dialog.defaultName}
          target={dialog.target}
          allowStub={data.allowStub}
          onSaved={(saved) => {
            setDialog(null);
            setNotice(`${saved.name} saved.`);
            router.refresh();
          }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete ${deleting?.name ?? "model"}?`}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (deleting) void remove(deleting);
        }}
      >
        Generations that would have used it fall back to the workspace&apos;s default. Its
        stored credentials are deleted with it.
      </ConfirmDialog>
    </div>
  );
}

function defaultLabel(section: WorkspaceModelsSection, server: ServerModelRow[]): string {
  const id = section.defaultModel;
  const own = section.models.find((m) => m.id === id);
  if (own) return `${own.name} (${own.model})`;
  const fromServer = server.find((m) => m.id === id) ?? server[0];
  return fromServer
    ? `the server's ${fromServer.name} (${fromServer.model || "not configured"})`
    : "no model";
}

function ServerCard({ rows, demo }: { rows: ServerModelRow[]; demo: boolean }) {
  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle>Server</CardTitle>
        <p className="text-xs text-muted">
          Declared by the operator in <span className="font-mono">AI_MODELS_FILE</span> or
          the <span className="font-mono">AI_*</span> variables. Read-only here
          {demo ? "; in demo mode they are the only models." : "."}
        </p>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            icon={<Cpu className="h-6 w-6" />}
            title="No server models"
            description="The operator has declared none."
          />
        ) : (
          <Table label="Server models">
            <TableHead>
              <TableRow>
                <TableHeader>Name</TableHeader>
                <TableHeader>Provider</TableHeader>
                <TableHeader>Model</TableHeader>
                <TableHeader>Credentials</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono">
                    {row.name} {row.isDefault && <Badge variant="outline">Default</Badge>}
                  </TableCell>
                  <TableCell>{providerLabel(row.provider)}</TableCell>
                  <TableCell className="font-mono">{row.model || "—"}</TableCell>
                  <TableCell className={row.unavailable ? "text-warning" : "text-muted"}>
                    {row.unavailable ??
                      (Object.keys(row.credentialVars).length > 0
                        ? `From ${Object.values(row.credentialVars).join(", ")}`
                        : "None needed")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * "Detected on this machine" (#607): the models the last scan found on the
 * endpoints the operator listed, and a Re-scan for whoever manages a
 * workspace. Read-only, like the server's.
 */
function DetectedCard({
  section,
  onScanned,
}: {
  section: DetectedModelsSection;
  onScanned: (message: string, ok: boolean) => void;
}) {
  const [scanning, setScanning] = React.useState(false);
  const answered = section.endpoints.filter((e) => e.ok);

  async function rescan() {
    if (!section.rescanWorkspace) return;
    setScanning(true);
    try {
      const res = await fetch("/api/models/detect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: section.rescanWorkspace }),
      });
      if (!res.ok) {
        onScanned((await readApiError(res)).error, false);
        return;
      }
      const result = (await res.json()) as {
        found: number;
        endpoints: Array<{ host: string; ok: boolean }>;
      };
      const reached = result.endpoints.filter((e) => e.ok).length;
      onScanned(
        `Re-scan found ${result.found} ${result.found === 1 ? "model" : "models"} on ${reached} of ${result.endpoints.length} endpoints.`,
        true,
      );
    } catch (err) {
      onScanned(apiErrorFromThrown(err).error, false);
    } finally {
      setScanning(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle>Detected on this machine</CardTitle>
          <p className="text-xs text-muted">
            Found by asking each endpoint in{" "}
            <span className="font-mono">LOCAL_MODEL_ENDPOINTS</span> for its models. No
            key needed.{" "}
            {section.scannedAt ? (
              <>
                Last scanned <LocalTime iso={section.scannedAt} />.
              </>
            ) : (
              "Not scanned yet."
            )}
          </p>
        </div>
        {section.rescanWorkspace && (
          <Button
            size="sm"
            variant="secondary"
            busy={scanning}
            onClick={() => void rescan()}
          >
            <RefreshCw className="h-4 w-4" /> Re-scan
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {section.rows.length === 0 ? (
          <EmptyState
            icon={<Cpu className="h-6 w-6" />}
            title="Nothing detected"
            description={
              section.local
                ? "Start Ollama or LM Studio on this machine, pull a model, then choose Re-scan."
                : "No listed endpoint answered with a model."
            }
          />
        ) : (
          <Table label="Detected models">
            <TableHead>
              <TableRow>
                <TableHeader>Name</TableHeader>
                <TableHeader>Provider</TableHeader>
                <TableHeader>Model</TableHeader>
                <TableHeader>Credentials</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {section.rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono">
                    {row.name} {row.isDefault && <Badge variant="outline">Default</Badge>}
                  </TableCell>
                  <TableCell>{providerLabel(row.provider)}</TableCell>
                  <TableCell className="font-mono">{row.model}</TableCell>
                  <TableCell className="text-muted">None needed</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {section.pickNeeded && (
          <p className="text-xs text-muted">
            More than one endpoint answered, so none is the default. Pick one in the model
            menu where you generate or chat; it is remembered for the workspace.
          </p>
        )}
        <p className="text-xs text-muted">
          {section.endpoints.length === 0
            ? "No endpoints are listed."
            : `${answered.length} of ${section.endpoints.length} endpoints answered: `}
          {section.endpoints.map((e, i) => (
            <React.Fragment key={e.host}>
              {i > 0 && ", "}
              <span className="font-mono">{e.host}</span>{" "}
              {e.ok
                ? `(${e.models} ${e.models === 1 ? "model" : "models"})`
                : "(no answer)"}
            </React.Fragment>
          ))}
          {section.endpoints.length > 0 && "."}
        </p>
      </CardContent>
    </Card>
  );
}

function ModelTable({
  rows,
  prefix,
  motion,
  empty,
  defaultId,
  actions,
}: {
  rows: CatalogModelRow[];
  prefix: string;
  motion: boolean;
  empty: string;
  defaultId: string | null;
  actions: (row: CatalogModelRow, rowId: string) => React.ReactNode;
}) {
  const body = React.useRef<HTMLTableSectionElement>(null);
  useFlip(body, motion);
  if (rows.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <Table>
      <TableHead>
        <TableRow>
          <TableHeader>Name</TableHeader>
          <TableHeader>Provider</TableHeader>
          <TableHeader>Model</TableHeader>
          <TableHeader>Credentials</TableHeader>
          <TableHeader>
            <span className="sr-only">Actions</span>
          </TableHeader>
        </TableRow>
      </TableHead>
      <TableBody ref={body}>
        {rows.map((row) => {
          const rowId = `${prefix}-${row.id}`;
          return (
            <TableRow key={row.id} id={rowId} data-flip-id={row.id}>
              <TableCell>
                {row.name}{" "}
                {defaultId === row.id && <Badge variant="outline">Default</Badge>}
              </TableCell>
              <TableCell>{providerLabel(row.provider)}</TableCell>
              <TableCell className="font-mono">{row.model}</TableCell>
              <TableCell className={row.unavailable ? "text-warning" : "text-muted"}>
                {row.unavailable ??
                  (row.view
                    ? row.view.key.state === "set"
                      ? row.view.key.hint
                        ? `Stored, ending in ${row.view.key.hint}`
                        : "Stored"
                      : "None stored"
                    : "Ready")}
              </TableCell>
              <TableCell>{actions(row, rowId)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
