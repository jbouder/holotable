"use client";

import * as React from "react";
import { Circle, CircleCheck, FileUp, Loader2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorDisplay } from "@/components/ui/error-display";
import { Progress } from "@/components/ui/progress";
import {
  formatBytes,
  perFileSent,
  sampleUploadFile,
  type UploadedFile,
  type UploadSample,
  uploadDuckDbFiles,
  uploadFilesProblem,
} from "@/lib/duckdb-form";
import { UPLOAD_ACCEPT } from "@/lib/sources/kinds/duckdb";
import type { UploadAvailability } from "@/lib/sources/types";
import { cn } from "@/lib/utils";

/**
 * The file picker the "Upload files" form has in place of a path (#595):
 * choose CSV or JSON files (or a sample), upload them with progress per file and
 * by stage, then the form goes on exactly as the server-files form does,
 * from discovery. Everything that decides anything is in `@/lib/duckdb-form`;
 * the server holds every rule again.
 */

/** Where an upload stands. */
type Phase = "idle" | "uploading" | "checking" | "stored" | "failed";

export function DuckDbUploadPicker({
  workspaceId,
  limits,
  discovering,
  discovered,
  error: fieldError,
  onUploaded,
  onReset,
}: {
  workspaceId: string;
  limits: UploadAvailability;
  /** The form is discovering the uploaded tables. */
  discovering: boolean;
  /** Discovery has answered. */
  discovered: boolean;
  /** The form's own error for the field, such as "upload first". */
  error?: string;
  /** The files are stored: the form sets the path and discovers. */
  onUploaded: (path: string, files: UploadedFile[]) => void;
  /** The chosen files changed after an upload: the form forgets its path. */
  onReset: () => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const abortRef = React.useRef<(() => void) | null>(null);
  const [files, setFiles] = React.useState<File[]>([]);
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [sent, setSent] = React.useState<{ loaded: number; total: number }>({
    loaded: 0,
    total: 0,
  });
  const [failure, setFailure] = React.useState<{
    error: string;
    file?: string;
    cancelled?: boolean;
  } | null>(null);
  const [stored, setStored] = React.useState<UploadedFile[]>([]);
  const [fetchingSample, setFetchingSample] = React.useState<UploadSample | null>(null);

  // An upload still running when the form goes away is cancelled with it.
  React.useEffect(() => () => abortRef.current?.(), []);

  const running = phase === "uploading" || phase === "checking";

  function choose(next: File[]) {
    setFiles(next);
    setFailure(next.length > 0 ? uploadFilesProblem(next, limits) : null);
    setStored([]);
    setSent({ loaded: 0, total: 0 });
    if (phase !== "idle") onReset();
    setPhase("idle");
  }

  async function trySample(which: UploadSample) {
    setFetchingSample(which);
    const sample = await sampleUploadFile(which);
    setFetchingSample(null);
    if (sample) choose([sample]);
    else setFailure({ error: "The sample could not be loaded from this server." });
  }

  async function upload() {
    const problem = uploadFilesProblem(files, limits);
    if (problem) {
      setFailure(problem);
      return;
    }
    setFailure(null);
    setPhase("uploading");
    setSent({ loaded: 0, total: 0 });
    const request = uploadDuckDbFiles(workspaceId, files, {
      onProgress: (loaded, total) => setSent({ loaded, total }),
      onSent: () => setPhase("checking"),
    });
    abortRef.current = request.abort;
    const outcome = await request.done;
    abortRef.current = null;
    if (!outcome.ok) {
      setPhase("failed");
      setFailure(outcome);
      return;
    }
    setStored(outcome.files);
    setPhase("stored");
    onUploaded(outcome.path, outcome.files);
  }

  const sizes = files.map((f) => f.size);
  const perFile =
    phase === "idle" || phase === "failed"
      ? sizes.map(() => 0)
      : phase === "uploading"
        ? perFileSent(sizes, sent.loaded, sent.total)
        : sizes;
  const sending = perFile.findIndex((bytes, i) => bytes < (sizes[i] ?? 0));
  const stage =
    phase === "uploading"
      ? `Uploading ${sending < 0 ? files.length : sending + 1} of ${files.length} ${files.length === 1 ? "file" : "files"}`
      : phase === "checking"
        ? "Checking files"
        : phase === "stored" && discovering
          ? "Discovering tables"
          : phase === "stored" && discovered
            ? "Done"
            : phase === "stored"
              ? "Uploaded"
              : null;

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <span id="d-files-label" className="text-sm font-medium">
          Files
        </span>
        <p id="d-files-hint" className="text-xs text-muted">
          CSV or JSON files from your computer, up to {limits.maxFiles} at{" "}
          {formatBytes(limits.maxBytes)} each. Each file becomes a table named after it.
        </p>
      </div>
      <input
        ref={inputRef}
        id="d-files"
        type="file"
        multiple
        accept={UPLOAD_ACCEPT}
        className="sr-only"
        aria-labelledby="d-files-label"
        aria-describedby="d-files-hint"
        onChange={(event) => {
          choose(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={running}
          onClick={() => inputRef.current?.click()}
        >
          <FileUp className="h-4 w-4" /> Choose files…
        </Button>
        <Button
          type="button"
          size="sm"
          busy={running}
          disabled={files.length === 0 || phase === "stored"}
          onClick={() => void upload()}
        >
          {running ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Upload className="h-4 w-4" />
          )}
          Upload
        </Button>
        {running && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => abortRef.current?.()}
          >
            <X className="h-4 w-4" /> Cancel upload
          </Button>
        )}
      </div>
      {files.length === 0 && (
        <p className="text-xs text-muted">
          No file handy? Try a sample:{" "}
          <button
            type="button"
            className="text-foreground underline underline-offset-2"
            aria-busy={fetchingSample === "expenses" || undefined}
            onClick={() => void trySample("expenses")}
          >
            household expenses
          </button>{" "}
          (a CSV, six months) or{" "}
          <button
            type="button"
            className="text-foreground underline underline-offset-2"
            aria-busy={fetchingSample === "workouts" || undefined}
            onClick={() => void trySample("workouts")}
          >
            workouts
          </button>{" "}
          (JSON lines, with a nested location).
        </p>
      )}

      {stage && (
        <StageLine
          phase={phase}
          discovering={discovering}
          discovered={discovered}
          text={stage}
        />
      )}

      {files.length > 0 && (
        <ul className="space-y-2" aria-label="Chosen files">
          {files.map((file, i) => {
            const failed = failure?.file === file.name;
            const done = phase === "stored";
            const bytes = perFile[i] ?? 0;
            const pct = file.size > 0 ? Math.round((bytes / file.size) * 100) : 0;
            const table = done ? stored[i]?.name : undefined;
            return (
              <li
                key={`${file.name}-${file.size}-${file.lastModified}`}
                className="stagger-in"
                style={{ "--i": i } as React.CSSProperties}
              >
                <Progress
                  label={file.name}
                  value={phase === "checking" ? null : bytes}
                  max={file.size || 1}
                  tone={failed ? "danger" : done ? "success" : "default"}
                  valueText={`${formatBytes(bytes)} of ${formatBytes(file.size)} · ${pct}%`}
                />
                <p
                  className={cn("mt-0.5 text-xs", failed ? "text-danger" : "text-muted")}
                >
                  {failed
                    ? "Refused"
                    : phase === "failed"
                      ? "Not kept"
                      : table
                        ? `Stored as the table ${table}`
                        : phase === "checking"
                          ? "Checking"
                          : null}
                </p>
              </li>
            );
          })}
        </ul>
      )}

      {fieldError && !failure && (
        <p id="d-files-error" className="text-xs text-danger">
          {fieldError}
        </p>
      )}
      {failure && <ErrorDisplay error={{ error: failure.error, kind: "validation" }} />}
    </div>
  );
}

/** The stages of an upload, each with its icon; a finished one pops its check in. */
function StageLine({
  phase,
  discovering,
  discovered,
  text,
}: {
  phase: Phase;
  discovering: boolean;
  discovered: boolean;
  text: string;
}) {
  const order: Phase[] = ["uploading", "checking", "stored"];
  const at = order.indexOf(phase);
  const stages: { label: string; state: "pending" | "running" | "done" }[] = [
    { label: "Upload", state: at > 0 ? "done" : at === 0 ? "running" : "pending" },
    { label: "Check", state: at > 1 ? "done" : at === 1 ? "running" : "pending" },
    {
      label: "Discover",
      state: discovered ? "done" : discovering ? "running" : "pending",
    },
  ];
  return (
    <div className="space-y-1">
      <p className="text-sm text-foreground" aria-live="polite">
        {text}
      </p>
      <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {stages.map((stage) => (
          <li key={stage.label} className="flex items-center gap-1">
            {stage.state === "done" ? (
              <CircleCheck
                key="done"
                className="pop-in h-3.5 w-3.5 text-success"
                aria-hidden
              />
            ) : stage.state === "running" ? (
              <Loader2 key="running" className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Circle key="pending" className="h-3.5 w-3.5" aria-hidden />
            )}
            <span>
              {stage.label}
              <span className="sr-only">
                {stage.state === "done"
                  ? ", done"
                  : stage.state === "running"
                    ? ", in progress"
                    : ""}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
