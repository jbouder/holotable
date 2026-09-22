"use client";

import * as React from "react";
import { AlertTriangle, Check, LayoutTemplate, Loader2, Trash2 } from "lucide-react";
import type { ApiError } from "@/lib/errors";
import { type RepointCheck, checkRepoint, summarizeChecks } from "@/lib/panel-repoint";
import {
  type Template,
  type TemplateKind,
  deleteTemplate,
  fetchTemplates,
  retargetTemplate,
  summarizeTemplate,
  templatePanels,
} from "@/lib/templates";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ErrorDisplay } from "@/components/ui/error-display";

/**
 * Pick a template and point it at a source.
 *
 * The source choice is the whole point of this dialog, not a detail of it. A
 * template's panels carry the source ids its author's panels had, and an id
 * means something only inside one registry — so a template applied anywhere
 * else has to be re-pointed, and guessing which source it meant would produce
 * a panel that reports plausible numbers from the wrong database. The target
 * is therefore explicit, and choosing one runs the guard over every statement
 * against *that* source's catalog before anything is applied.
 *
 * The verdicts are held with the source they answer about and dropped the
 * moment a different one is picked, for the reason `RepointPanelsDialog` does
 * the same: a stale "valid" is worse than no verdict. A failing template can
 * still be applied — the editor is where a statement gets fixed, and getting
 * it into the editor is the point — but the author sees what will break first.
 *
 * Nothing here writes a dashboard. `onApply` hands the caller an ordinary
 * retargeted body, which lands in the spec being edited and is saved through
 * the usual endpoint, so the server re-validates every statement anyway.
 */
export function TemplatePicker({
  workspaceId,
  kind,
  sources,
  defaultSourceId,
  applyLabel,
  onApply,
  onClose,
}: {
  workspaceId: string;
  /** Narrow the list to one kind; omitted offers both. */
  kind?: TemplateKind;
  sources: { id: string; name: string }[];
  defaultSourceId?: string;
  applyLabel: string;
  onApply: (input: { template: Template; sourceId: string }) => void;
  onClose: () => void;
}) {
  const [target, setTarget] = React.useState<string | null>(
    defaultSourceId ?? sources[0]?.id ?? null,
  );
  const [templates, setTemplates] = React.useState<Template[] | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [listError, setListError] = React.useState<ApiError | null>(null);
  const [verdicts, setVerdicts] = React.useState<{
    key: string;
    checks: RepointCheck[];
  } | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [removing, setRemoving] = React.useState<string | null>(null);

  // Re-listed whenever the target changes: the built-ins are parameterized by
  // the chosen source's catalog, so they are a different set for each one.
  React.useEffect(() => {
    let active = true;
    setTemplates(null);
    setSelectedId(null);
    setListError(null);
    void (async () => {
      const outcome = await fetchTemplates({
        workspaceId,
        kind,
        sourceId: target ?? undefined,
      });
      if (!active) return;
      if (outcome.ok) setTemplates(outcome.templates);
      else setListError(outcome.error);
    })();
    return () => {
      active = false;
    };
  }, [workspaceId, kind, target]);

  const selected = templates?.find((t) => t.id === selectedId) ?? null;
  // The key ties a set of verdicts to the exact question it answered, so a
  // template change and a source change both retire them.
  const key = selected && target ? `${selected.id}\u0000${target}` : null;

  React.useEffect(() => {
    if (!selected || !target) return;
    const subject = `${selected.id}\u0000${target}`;
    let active = true;
    setVerdicts(null);
    setChecking(true);
    void (async () => {
      const panels = templatePanels(retargetTemplate(selected.body, target));
      const checks = await checkRepoint(panels, target);
      if (!active) return;
      setVerdicts({ key: subject, checks });
      setChecking(false);
    })();
    return () => {
      active = false;
    };
  }, [selected, target]);

  const checks = verdicts?.key === key ? verdicts.checks : null;

  async function remove(template: Template) {
    setRemoving(template.id);
    const outcome = await deleteTemplate(template.id);
    setRemoving(null);
    if (!outcome.ok) {
      setListError(outcome.error);
      return;
    }
    setTemplates((list) => (list ?? []).filter((t) => t.id !== template.id));
    if (selectedId === template.id) setSelectedId(null);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Start from a template"
    >
      <div className="space-y-4">
        {sources.length === 0 ? (
          <p className="text-sm text-danger">
            There is no source in this workspace to point a template at. Add one on the
            Data sources page first.
          </p>
        ) : (
          <>
            <div>
              <Label htmlFor="template-target">Data source</Label>
              <Select
                id="template-target"
                value={target}
                onValueChange={setTarget}
                options={sources.map((s) => ({ value: s.id, label: s.name }))}
              />
              <p className="mt-1 text-xs text-muted">
                Every panel the template brings is re-pointed here, and its SQL is checked
                against this source&rsquo;s catalog.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Template</Label>
              {templates === null ? (
                <p className="flex items-center gap-2 text-sm text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading templates…
                </p>
              ) : templates.length === 0 ? (
                <p className="text-sm text-muted">
                  No templates yet, and this source&rsquo;s catalog does not support the
                  built-in golden-signal starters. Save a panel or a dashboard as a
                  template to build the list up.
                </p>
              ) : (
                <ul className="max-h-64 space-y-1 overflow-y-auto">
                  {templates.map((template) => {
                    const active = template.id === selectedId;
                    return (
                      <li key={template.id}>
                        <div
                          className={`flex items-start gap-2 rounded-lg border p-2 ${
                            active
                              ? "border-primary bg-surface-2"
                              : "border-border bg-surface"
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => setSelectedId(template.id)}
                            className="min-w-0 flex-1 cursor-pointer text-left"
                          >
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="truncate text-sm font-medium">
                                {template.name}
                              </span>
                              <Badge>{template.kind}</Badge>
                              {template.origin === "builtin" && (
                                <Badge variant="outline">built-in</Badge>
                              )}
                            </span>
                            {template.description && (
                              <span className="mt-0.5 block text-xs text-muted">
                                {template.description}
                              </span>
                            )}
                            <span className="mt-0.5 block text-xs text-muted">
                              {summarizeTemplate(template.body)}
                            </span>
                          </button>
                          {template.origin === "workspace" && (
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Delete template ${template.name}`}
                              disabled={removing === template.id}
                              onClick={() => void remove(template)}
                            >
                              {removing === template.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Trash2 className="h-4 w-4 text-muted hover:text-danger" />
                              )}
                            </Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {selected && (
              <div className="space-y-2">
                <div className="flex items-baseline justify-between gap-2">
                  <Label>Against this source</Label>
                  <span className="text-xs text-muted">
                    {checking ? "Checking SQL…" : checks ? summarizeChecks(checks) : null}
                  </span>
                </div>
                <ul className="space-y-1">
                  {templatePanels(selected.body).map((panel) => {
                    const verdict = checks?.find((c) => c.panelId === panel.id);
                    return (
                      <li
                        key={panel.id}
                        className="rounded-lg border border-border bg-surface-2 p-2 text-xs"
                      >
                        <span className="block font-medium text-foreground">
                          {panel.title}
                        </span>
                        {checking || !verdict ? (
                          <span className="mt-0.5 flex items-center gap-1.5 text-muted">
                            <Loader2 className="h-3 w-3 animate-spin" /> Checking…
                          </span>
                        ) : verdict.check.ok ? (
                          <span className="mt-0.5 flex items-start gap-1.5 text-success">
                            <Check className="mt-px h-3 w-3 shrink-0" /> Validates against
                            this source.
                          </span>
                        ) : (
                          <span className="mt-0.5 flex items-start gap-1.5 text-warning">
                            <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                            {verdict.check.error.error}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <p className="text-xs text-muted">
                  A panel that does not validate is still applied — fix its SQL in the
                  editor, where completion and the Run preview work off this source.
                </p>
              </div>
            )}
          </>
        )}

        {listError && <ErrorDisplay error={listError} />}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!selected || !target}
            onClick={() => {
              if (selected && target) onApply({ template: selected, sourceId: target });
            }}
          >
            <LayoutTemplate className="h-4 w-4" /> {applyLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
