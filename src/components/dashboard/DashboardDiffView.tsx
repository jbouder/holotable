"use client";

import { Minus, Plus, PenLine } from "lucide-react";
import type { DashboardDiff, PanelChange } from "@/lib/dashboard-versions";
import type { Panel } from "@/lib/ir";
import { Badge } from "@/components/ui/badge";
import { FieldRow, SqlDiffLines } from "@/components/dashboard/PanelDiffView";

/**
 * Two versions of one dashboard, compared panel by panel (#73).
 *
 * Presentational only: it renders the {@link DashboardDiff} it is handed. A
 * changed panel reuses the NL panel edit's field rows and SQL line diff, so a
 * change reads the same in the history as it did when it was proposed.
 */

function summary(diff: DashboardDiff): string {
  const parts: string[] = [];
  for (const kind of ["changed", "added", "removed"] as const) {
    const n = diff.panels.filter((p) => p.kind === kind).length;
    if (n > 0) parts.push(`${n} panel${n === 1 ? "" : "s"} ${kind}`);
  }
  const settings = diff.fields.filter((f) => f.changed).length;
  if (settings > 0) parts.push(`${settings} setting${settings === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function wholeSql(panel: Panel, kind: "add" | "remove") {
  return panel.query.sql
    .replace(/\n+$/, "")
    .split(/\r?\n/)
    .map((text) => ({ kind, text }));
}

const KIND_ICON = {
  added: <Plus className="h-3.5 w-3.5 text-success" aria-hidden />,
  removed: <Minus className="h-3.5 w-3.5 text-danger" aria-hidden />,
  changed: <PenLine className="h-3.5 w-3.5 text-muted" aria-hidden />,
};

function PanelChangeView({ change }: { change: PanelChange }) {
  const panel = change.kind === "changed" ? change.after : change.panel;
  const changedFields =
    change.kind === "changed" ? change.diff.fields.filter((f) => f.changed) : [];

  return (
    <li className="space-y-2 border border-border p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {KIND_ICON[change.kind]}
        <span className="font-medium">{panel.title}</span>
        <Badge variant="outline">{change.kind}</Badge>
        <span className="text-xs text-muted">{panel.viz}</span>
      </div>

      {change.kind === "changed" && (
        <>
          {changedFields.length > 0 && (
            <div className="divide-y divide-border">
              {changedFields.map((f) => (
                <FieldRow
                  key={f.key}
                  label={f.label}
                  before={f.before}
                  after={f.after}
                  changed
                />
              ))}
            </div>
          )}
          {change.diff.sql.changed && (
            <div className="space-y-1">
              <div className="text-xs text-muted">
                SQL <span className="text-success">+{change.diff.sql.added}</span>{" "}
                <span className="text-danger">−{change.diff.sql.removed}</span>
              </div>
              <SqlDiffLines lines={change.diff.sql.lines} />
            </div>
          )}
        </>
      )}
      {change.kind !== "changed" && (
        <SqlDiffLines
          lines={wholeSql(change.panel, change.kind === "added" ? "add" : "remove")}
        />
      )}
    </li>
  );
}

export function DashboardDiffView({
  diff,
  fromLabel,
  toLabel,
}: {
  diff: DashboardDiff;
  /** The older side, e.g. "v3". */
  fromLabel: string;
  /** The newer side, e.g. "v7 (current)". */
  toLabel: string;
}) {
  if (diff.identical) {
    return (
      <p className="text-sm text-muted">
        {fromLabel} and {toLabel} are identical.
      </p>
    );
  }

  const settings = diff.fields.filter((f) => f.changed);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        From {fromLabel} to {toLabel}: {summary(diff) || "panel order only"}
        {diff.unchangedPanels > 0 &&
          ` · ${diff.unchangedPanels} panel${diff.unchangedPanels === 1 ? "" : "s"} unchanged`}
      </p>

      {settings.length > 0 && (
        <div className="divide-y divide-border border border-border px-3 py-1">
          {settings.map((f) => (
            <FieldRow
              key={f.key}
              label={f.label}
              before={f.before}
              after={f.after}
              changed
            />
          ))}
        </div>
      )}

      {diff.reordered && <p className="text-xs text-muted">The panel order changed.</p>}

      {diff.panels.length > 0 && (
        <ul className="space-y-3">
          {diff.panels.map((change) => (
            <PanelChangeView
              key={`${change.kind}:${change.kind === "changed" ? change.after.id : change.panel.id}`}
              change={change}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
