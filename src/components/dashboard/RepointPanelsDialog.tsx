"use client";

import * as React from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import type { Panel } from "@/lib/ir";
import { type RepointCheck, checkRepoint, summarizeChecks } from "@/lib/panel-repoint";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

/**
 * Move panels off a removed source and onto a live one.
 *
 * Every panel in `panels` names the same dead source; whether that is the one
 * panel being edited or all of them on the dashboard is the caller's choice,
 * which is what makes the same dialog serve the single and the bulk case.
 *
 * Choosing a target runs the guard over each panel's SQL against that source's
 * catalog, so the author sees which statements survive the move *before* the
 * re-point lands in the spec. The verdicts are tied to the source they were
 * reached against and are dropped the moment a different one is picked — a
 * stale "valid" would be worse than no verdict at all.
 *
 * A failing panel can still be re-pointed, deliberately: the editor's SQL
 * completion and the Run preview work off the panel's source, so re-pointing
 * first is how the author gets the tools to fix the statement. Nothing is
 * saved here either way — the caller applies the change to the spec in the
 * editor and the existing Save writes a new version.
 */
export function RepointPanelsDialog({
  deadSourceId,
  panels,
  sources,
  onApply,
  onClose,
}: {
  deadSourceId: string;
  panels: Panel[];
  sources: { id: string; name: string }[];
  onApply: (input: { sourceId: string; panelIds: string[] }) => void;
  onClose: () => void;
}) {
  // The set under review is frozen when the dialog opens. It is modal, so the
  // set cannot meaningfully change while it is up, and a caller re-rendering a
  // freshly built array must not restart the checks underneath the author.
  const [reviewed] = React.useState(panels);
  const [target, setTarget] = React.useState<string | null>(sources[0]?.id ?? null);
  const [selected, setSelected] = React.useState<string[]>(() =>
    reviewed.map((p) => p.id),
  );
  // The verdicts, and the source they answer about. Held together so a target
  // change cannot leave last source's verdicts on screen.
  const [verdicts, setVerdicts] = React.useState<{
    sourceId: string;
    checks: RepointCheck[];
  } | null>(null);
  const [checking, setChecking] = React.useState(false);

  React.useEffect(() => {
    if (!target) return;
    let active = true;
    setVerdicts(null);
    setChecking(true);
    void (async () => {
      const checks = await checkRepoint(reviewed, target);
      if (!active) return;
      setVerdicts({ sourceId: target, checks });
      setChecking(false);
    })();
    return () => {
      active = false;
    };
  }, [target, reviewed]);

  const checks = verdicts?.sourceId === target ? verdicts.checks : null;
  const verdictFor = (panelId: string) => checks?.find((c) => c.panelId === panelId);

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Re-point panels to another source"
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          {reviewed.length === 1 ? "This panel" : `These ${reviewed.length} panels`} point
          at <code>{deadSourceId}</code>, which is no longer available. Until the
          reference moves, this dashboard cannot be saved.
        </p>

        {sources.length === 0 ? (
          <p className="text-sm text-danger">
            There is no other source in this workspace to re-point to. Add one on the Data
            sources page first.
          </p>
        ) : (
          <>
            <div>
              <Label htmlFor="repoint-source">New source</Label>
              <Select
                id="repoint-source"
                value={target}
                onValueChange={setTarget}
                options={sources.map((s) => ({ value: s.id, label: s.name }))}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <Label>Panels to move</Label>
                <span className="text-xs text-muted">
                  {checking ? "Checking SQL…" : checks ? summarizeChecks(checks) : null}
                </span>
              </div>
              <ul className="space-y-2">
                {reviewed.map((panel) => {
                  const verdict = verdictFor(panel.id);
                  return (
                    <li key={panel.id} className="border border-border bg-surface-2 p-2">
                      <Checkbox
                        checked={selected.includes(panel.id)}
                        onCheckedChange={(checked) =>
                          setSelected((ids) =>
                            checked
                              ? [...new Set([...ids, panel.id])]
                              : ids.filter((id) => id !== panel.id),
                          )
                        }
                        label={panel.title}
                      />
                      <p className="mt-1 flex items-start gap-1.5 pl-6 text-xs">
                        {checking || !verdict ? (
                          <span className="flex items-center gap-1.5 text-muted">
                            <Loader2 className="h-3 w-3 animate-spin" /> Checking the SQL
                            against this source…
                          </span>
                        ) : verdict.check.ok ? (
                          <span className="flex items-start gap-1.5 text-success">
                            <Check className="mt-px h-3 w-3 shrink-0" /> The SQL still
                            validates against this source.
                          </span>
                        ) : (
                          <span className="flex items-start gap-1.5 text-warning">
                            <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                            {verdict.check.error.error}
                          </span>
                        )}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </div>
          </>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!target || selected.length === 0}
            onClick={() => {
              if (target) onApply({ sourceId: target, panelIds: selected });
            }}
          >
            Re-point {selected.length} {selected.length === 1 ? "panel" : "panels"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
