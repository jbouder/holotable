"use client";

import * as React from "react";
import { Check, ChevronDown, ChevronRight, Loader2, RefreshCw, X } from "lucide-react";
import type { PanelDiff, SqlLine } from "@/lib/panel-diff";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * The review surface for a natural-language panel edit.
 *
 * Presentational only: it renders the {@link PanelDiff} it is handed and calls
 * back. Nothing is applied to the spec until the author presses Accept — this
 * component cannot apply anything itself, which is the point of the issue it
 * comes from.
 */

const LINE_STYLES: Record<SqlLine["kind"], string> = {
  add: "bg-success/10 text-foreground",
  remove: "bg-danger/10 text-muted line-through decoration-danger/40",
  context: "text-muted",
};

const LINE_MARKS: Record<SqlLine["kind"], string> = {
  add: "+",
  remove: "-",
  context: " ",
};

function FieldRow({
  label,
  before,
  after,
  changed,
}: {
  label: string;
  before: string;
  after: string;
  changed: boolean;
}) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-2 py-1 text-xs">
      <span className="text-muted">{label}</span>
      {changed ? (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="bg-danger/10 px-1.5 py-0.5 text-muted line-through decoration-danger/40">
            {before}
          </span>
          <span aria-hidden="true" className="text-muted">
            →
          </span>
          <span className="bg-success/10 px-1.5 py-0.5 text-foreground">{after}</span>
        </span>
      ) : (
        <span className="text-foreground">{before}</span>
      )}
    </div>
  );
}

export function PanelDiffView({
  diff,
  model,
  streaming,
  onAccept,
  onReject,
  onRegenerate,
}: {
  diff: PanelDiff;
  /** The model that produced this proposal, so the cost of a regenerate is visible. */
  model?: string;
  /** The object is still arriving; the diff fills in as it does. */
  streaming: boolean;
  onAccept: () => void;
  onReject: () => void;
  onRegenerate: (feedback: string) => void;
}) {
  const [showUnchanged, setShowUnchanged] = React.useState(false);
  const [feedback, setFeedback] = React.useState("");
  const unchanged = diff.fields.filter((f) => !f.changed);
  const changed = diff.fields.filter((f) => f.changed);

  return (
    <div className="space-y-3 border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Label className="mb-0">
            {streaming ? (
              <span className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="animate-pulse">Proposed changes…</span>
              </span>
            ) : (
              "Proposed changes"
            )}
          </Label>
          {model && <Badge title="Generation model">{model}</Badge>}
          {!streaming && (
            <Badge>
              {diff.identical
                ? "no changes"
                : `${diff.changedFields} field${diff.changedFields === 1 ? "" : "s"}${
                    diff.sql.changed
                      ? ` · SQL +${diff.sql.added}/−${diff.sql.removed}`
                      : ""
                  }`}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={onReject}>
            <X className="h-4 w-4" /> Reject
          </Button>
          <Button size="sm" onClick={onAccept} disabled={streaming || diff.identical}>
            <Check className="h-4 w-4" /> Accept
          </Button>
        </div>
      </div>

      <div className="divide-y divide-border">
        {changed.length === 0 && !streaming && !diff.sql.changed && (
          <p className="py-1 text-xs text-muted">
            The generated panel is identical to the current one.
          </p>
        )}
        {changed.map((f) => (
          <FieldRow
            key={f.key}
            label={f.label}
            before={f.before}
            after={f.after}
            changed={f.changed}
          />
        ))}
      </div>

      {unchanged.length > 0 && (
        <div>
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted hover:text-foreground"
            onClick={() => setShowUnchanged((v) => !v)}
            aria-expanded={showUnchanged}
          >
            {showUnchanged ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            {unchanged.length} unchanged field{unchanged.length === 1 ? "" : "s"}
          </button>
          {showUnchanged && (
            <div className="mt-1 divide-y divide-border">
              {unchanged.map((f) => (
                <FieldRow
                  key={f.key}
                  label={f.label}
                  before={f.before}
                  after={f.after}
                  changed={f.changed}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="space-y-1">
        <div className="flex items-center gap-2 text-xs text-muted">
          SQL
          {diff.sql.changed ? (
            <span>
              <span className="text-success">+{diff.sql.added}</span>{" "}
              <span className="text-danger">−{diff.sql.removed}</span>
            </span>
          ) : (
            <span>unchanged</span>
          )}
        </div>
        <pre className="max-h-72 overflow-auto border border-border bg-background p-2 font-mono text-xs leading-relaxed">
          {diff.sql.lines.map((line, i) => (
            <div
              // Line numbers repeat across kinds, so position is the only
              // stable key here; the list is rebuilt wholesale anyway.
              // biome-ignore lint/suspicious/noArrayIndexKey: positional diff rows
              key={i}
              className={cn("whitespace-pre px-1", LINE_STYLES[line.kind])}
            >
              <span className="select-none pr-2 text-muted/60">
                {LINE_MARKS[line.kind]}
              </span>
              {line.text}
            </div>
          ))}
        </pre>
      </div>

      <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
        <div className="min-w-48 flex-1">
          <Label htmlFor="regen-feedback">Feedback for a regenerate (optional)</Label>
          <Input
            id="regen-feedback"
            value={feedback}
            placeholder="e.g. keep the existing SQL, only change the chart type"
            onChange={(e) => setFeedback(e.target.value)}
          />
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => onRegenerate(feedback)}
          disabled={streaming}
        >
          <RefreshCw className="h-4 w-4" />
          Regenerate
        </Button>
      </div>
    </div>
  );
}
