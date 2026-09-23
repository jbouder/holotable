"use client";

import { AlertTriangle, CheckCircle2, ShieldAlert, ShieldCheck, X } from "lucide-react";
import {
  formatLatency,
  hasFinding,
  readOnlyHeadline,
  readOnlyTone,
  shortVersion,
  type SourceTestResult,
  summarizeTables,
} from "@/lib/source-test";
import { cn } from "@/lib/utils";

/**
 * The result of a source test, as a panel rather than a line (#126).
 *
 * The old answer was `connection succeeded`, which is true of a database whose
 * role can drop tables and whose allowlist names three tables that no longer
 * exist. Everything here exists to make one of those states impossible to read
 * as a pass — which is why the read-only verdict is the loudest thing on it
 * and why a green overall tick requires `hasFinding` to be false, not merely
 * `ok` to be true.
 */
export function SourceTestReport({
  sourceName,
  result,
  onDismiss,
}: {
  sourceName: string;
  result: SourceTestResult;
  onDismiss: () => void;
}) {
  const finding = hasFinding(result);

  return (
    <section
      aria-label={`Test result for ${sourceName}`}
      className={cn(
        "border bg-surface p-3 text-sm",
        finding ? "border-warning/50" : "border-success/40",
      )}
    >
      <header className="mb-2 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          {result.ok ? (
            <CheckCircle2
              className={cn("h-4 w-4", finding ? "text-warning" : "text-success")}
            />
          ) : (
            <AlertTriangle className="h-4 w-4 text-danger" />
          )}
          <span className="font-medium text-foreground">
            {sourceName}: {result.message}
          </span>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss test result"
          className="inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center text-muted transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      {result.readOnly && <ReadOnlyVerdictRow result={result} />}

      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-muted sm:grid-cols-2">
        {result.latency && (
          <Fact label="Latency">
            {formatLatency(result.latency.connectMs)} to connect,{" "}
            {formatLatency(result.latency.queryMs)} to query
          </Fact>
        )}
        {result.server && (
          <Fact label="Server">
            <span title={result.server.version}>
              {shortVersion(result.server.version)}
            </span>
            {result.server.timescaledb
              ? ` · TimescaleDB ${result.server.timescaledb}`
              : " · no TimescaleDB extension"}
          </Fact>
        )}
        {result.role && (
          <Fact label="Role">
            {result.role.currentUser}
            {/*
              Worth showing only when they differ: equal is the ordinary case
              and saying it twice teaches people to stop reading the line.
            */}
            {result.role.sessionUser !== result.role.currentUser &&
              ` (logged in as ${result.role.sessionUser})`}
          </Fact>
        )}
        {result.role && <Fact label="search_path">{result.role.searchPath}</Fact>}
      </dl>

      {result.tables && result.tables.length > 0 && (
        <div className="mt-2">
          <p className="text-xs text-muted">{summarizeTables(result.tables)}</p>
          {/*
            Only the tables that failed are listed. A hundred readable tables
            is a sentence; three unreadable ones are the report.
          */}
          <ul className="mt-1 space-y-0.5">
            {result.tables
              .filter((t) => !t.reachable)
              .map((t) => (
                <li key={t.table} className="text-xs text-danger">
                  <span className="font-medium">{t.table}</span>
                  {t.error ? ` — ${t.error}` : ""}
                </li>
              ))}
          </ul>
        </div>
      )}
    </section>
  );
}

const TONE_STYLES = {
  ok: "border-success/40 text-success",
  warning: "border-warning/50 text-warning",
  danger: "border-danger/60 bg-danger/10 text-danger",
} as const;

function ReadOnlyVerdictRow({ result }: { result: SourceTestResult }) {
  const readOnly = result.readOnly;
  if (!readOnly) return null;
  const tone = readOnlyTone(readOnly.verdict);
  const Icon = tone === "ok" ? ShieldCheck : ShieldAlert;

  return (
    <div
      className={cn(
        "mb-2 flex items-start gap-2 border px-2 py-1.5 text-xs",
        TONE_STYLES[tone],
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <p className="font-medium">{readOnlyHeadline(readOnly.verdict)}</p>
        <p className="mt-0.5 text-muted">{readOnly.detail}</p>
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-1.5">
      <dt className="shrink-0 font-medium">{label}:</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  );
}
