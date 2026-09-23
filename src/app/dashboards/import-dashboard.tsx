"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Upload } from "lucide-react";
import {
  type DashboardExportFile,
  type ImportTarget,
  type SourceMapping,
  importDashboard,
  readExportFile,
  referencedSourceIds,
} from "@/lib/dashboard-export";
import type { ApiError } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Dialog } from "@/components/ui/dialog";
import { ErrorDisplay } from "@/components/ui/error-display";

/**
 * Import a dashboard someone exported.
 *
 * The step that carries the weight is the source mapping. An export names its
 * sources by id, and an id means something only inside one registry, so a file
 * moving between deployments almost always arrives naming sources the target
 * workspace does not have. Rather than guess — a wrong guess points a panel at
 * the wrong database and reports plausible numbers — the dialog lists each
 * referenced id and makes the user say what it becomes here, and the Import
 * button stays disabled until every one of them resolves.
 *
 * `targets` is projected on the server to an id and a name per source. The
 * catalog and the connection config never reach the browser.
 */
export function ImportDashboard({ targets }: { targets: ImportTarget[] }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [file, setFile] = React.useState<DashboardExportFile | null>(null);
  const [fileName, setFileName] = React.useState("");
  const [workspaceId, setWorkspaceId] = React.useState(targets[0]?.workspaceId ?? "");
  const [mapping, setMapping] = React.useState<SourceMapping>({});
  const [importing, setImporting] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  function reset() {
    setFile(null);
    setFileName("");
    setMapping({});
    setError(null);
    setWorkspaceId(targets[0]?.workspaceId ?? "");
    if (inputRef.current) inputRef.current.value = "";
  }

  function openDialog() {
    reset();
    setOpen(true);
  }

  async function pick(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0];
    if (!picked) return;
    setFileName(picked.name);
    setMapping({});
    const outcome = readExportFile(await picked.text());
    if (!outcome.ok) {
      setFile(null);
      setError(outcome.error);
      return;
    }
    setError(null);
    setFile(outcome.file);
  }

  const target = targets.find((t) => t.workspaceId === workspaceId) ?? targets[0];
  const available = new Set((target?.sources ?? []).map((s) => s.id));
  const referenced = file ? referencedSourceIds(file.spec) : [];
  const resolvedId = (id: string) => mapping[id] ?? id;
  const unresolved = referenced.filter((id) => !available.has(resolvedId(id)));

  async function runImport() {
    if (!file || !target) return;
    setImporting(true);
    setError(null);
    const outcome = await importDashboard({
      workspaceId: target.workspaceId,
      file,
      sourceMapping: mapping,
    });
    setImporting(false);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    setOpen(false);
    router.push(`/dashboards/${outcome.dashboardId}`);
  }

  return (
    <>
      <Button variant="secondary" onClick={openDialog}>
        <Upload className="h-4 w-4" /> Import
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
        title="Import a dashboard"
        className="max-w-lg"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted">
            Pick a dashboard JSON file exported from Holotable. It is created as a new
            dashboard at version 1 — nothing existing is overwritten.
          </p>

          <div>
            <input
              ref={inputRef}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              aria-label="Dashboard JSON file"
              onChange={(e) => void pick(e)}
            />
            <div className="flex items-center gap-3">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => inputRef.current?.click()}
                disabled={importing}
              >
                Choose file…
              </Button>
              <span className="truncate text-sm text-muted">
                {fileName || "No file chosen"}
              </span>
            </div>
          </div>

          {file && (
            <div className="border border-border bg-surface-2 p-3 text-sm">
              <div className="font-medium">{file.spec.title}</div>
              <div className="text-xs text-muted">
                {file.spec.panels.length}{" "}
                {file.spec.panels.length === 1 ? "panel" : "panels"} ·{" "}
                {file.spec.timeRange.from} → {file.spec.timeRange.to} · refresh{" "}
                {Math.round(file.spec.refreshIntervalMs / 1000)}s
              </div>
            </div>
          )}

          {file && targets.length > 1 && (
            <div>
              <Label htmlFor="import-workspace">Workspace</Label>
              <Select
                id="import-workspace"
                className="w-full"
                value={target?.workspaceId ?? null}
                onValueChange={(next) => {
                  setWorkspaceId(next);
                  // A chosen target source belongs to the workspace it was
                  // chosen from; keeping it would silently name a source the
                  // new workspace does not have.
                  setMapping({});
                }}
                options={targets.map((t) => ({
                  value: t.workspaceId,
                  label: t.workspaceId,
                }))}
              />
            </div>
          )}

          {file && referenced.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="import-sources">Data sources</Label>
              <div id="import-sources" className="space-y-2">
                {referenced.map((id) => {
                  const resolved = available.has(resolvedId(id));
                  return (
                    <div key={id} className="flex items-center justify-between gap-3">
                      <code className="truncate text-xs text-muted">{id}</code>
                      {resolved && !mapping[id] ? (
                        <span className="flex shrink-0 items-center gap-1 text-xs text-muted">
                          <Check className="h-3.5 w-3.5" /> in this workspace
                        </span>
                      ) : (
                        <Select
                          className="w-56 shrink-0"
                          value={mapping[id] ?? null}
                          placeholder="Map to…"
                          onValueChange={(next) =>
                            setMapping((prev) => ({ ...prev, [id]: next }))
                          }
                          options={(target?.sources ?? []).map((s) => ({
                            value: s.id,
                            label: s.name,
                          }))}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
              {unresolved.length > 0 && (
                <p className="text-xs text-warning">
                  {unresolved.length === 1
                    ? "One source is"
                    : `${unresolved.length} sources are`}{" "}
                  not in this workspace. Map {unresolved.length === 1 ? "it" : "them"} to
                  a source here to import.
                </p>
              )}
            </div>
          )}

          {error && <ErrorDisplay error={error} />}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={importing}>
              Cancel
            </Button>
            <Button
              onClick={() => void runImport()}
              disabled={!file || !target || unresolved.length > 0 || importing}
            >
              {importing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              Import
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
