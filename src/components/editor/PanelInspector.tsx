"use client";

import * as React from "react";
import { Copy, LayoutTemplate, MoreHorizontal, Trash2, X } from "lucide-react";
import {
  type Dashboard,
  hasQuery,
  type Panel,
  panelTimeRange,
  Duration,
  type PromqlQuery,
  type QueryPanel,
  queryLanguage,
  ValueFormat,
  VizType,
  isSqlQuery,
} from "@/lib/ir";
import { changePanelKind } from "@/lib/panel-kind-change";
import { panelKind } from "@/lib/panels/registry";
import { TEXT_CONTENT_MAX } from "@/lib/panels/kinds/text";
import { starterQuery } from "@/lib/panel-starter";
import { validatePanelQuery } from "@/lib/panel-query";
import {
  type EditorCatalog,
  type SourceKindName,
  sourceKind,
} from "@/lib/sources/registry";
import type { VariableValues } from "@/lib/sql/variables";
import { MarkdownView } from "@/components/panels/text";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/menu";
import { Select } from "@/components/ui/select";
import { SqlEditor } from "@/components/sql/SqlEditor";
import { PromqlEditor, type PromqlVerdict } from "@/components/promql/PromqlEditor";
import { Checkbox } from "@/components/ui/checkbox";
import { TimeFieldPicker } from "@/components/sql/TimeFieldPicker";
import { PanelPreview, usePanelPreview } from "@/components/dashboard/PanelPreview";
import {
  PanelPresentationFields,
  PanelTimingFields,
} from "@/components/editor/panel-settings";
import { InspectorSection } from "@/components/editor/InspectorSection";
import { LinksEditor } from "@/components/editor/links-editor";

export interface SourceOption {
  id: string;
  name: string;
  workspaceId: string;
  /** Which kind, so the editor knows the language its panels are written in (#388). */
  kind: SourceKindName;
  /**
   * Tables and columns, or metrics and labels, for completion and the
   * editor's allowlist hints. Never where the source lives.
   */
  catalog: EditorCatalog;
}

/** The SQL catalog, when the source has one, for the SQL editor's completion. */
function sqlCatalog(catalog: EditorCatalog | null) {
  return catalog && "tables" in catalog ? catalog : null;
}

/** The metric catalog, when the source has one, for the PromQL editor's. */
function promqlCatalog(catalog: EditorCatalog | null) {
  return catalog && "metrics" in catalog ? catalog : null;
}

/** How a spec change is recorded in the undo stack. */
export interface EditIntent {
  action: string;
  /** Consecutive edits sharing a key coalesce into one history entry. */
  key?: string | null;
}

type OnPanelChange = (fn: (p: Panel) => Panel, intent: EditIntent) => void;

const VIZ_OPTIONS = VizType.options.map((v) => ({ value: v, label: v }));
/** `Panel.description` is `z.string().max(500)`; the box stops at the same place. */
const PANEL_DESCRIPTION_MAX = 500;
const FORMAT_OPTIONS = [
  { value: "", label: "none" },
  ...ValueFormat.options.map((f) => ({ value: f, label: f })),
];

/**
 * The editor's inspector for the selected panel (#357), in the order an
 * author reaches for things: ask the model, then the data, then how it looks.
 * Position and size are not here: they are edited on the canvas, by dragging,
 * resizing or the arrow keys, and only there.
 */
export function PanelInspector({
  panel,
  sources,
  timeRange,
  refreshIntervalMs,
  variables,
  sourceMissing,
  ai,
  onRepoint,
  onChange,
  onClose,
  onDuplicate,
  onSaveAsTemplate,
  onDelete,
  links,
}: {
  panel: Panel;
  sources: SourceOption[];
  timeRange: Dashboard["timeRange"];
  refreshIntervalMs: number;
  /** The values the preview binds for the dashboard's variables (#67). */
  variables: VariableValues;
  /** This panel's source is not among the workspace's live sources. */
  sourceMissing: boolean;
  /** The natural-language edit, owned by the page because it owns the stream. */
  ai: React.ReactNode;
  onRepoint: () => void;
  /** Each control names its own undo step, so a burst of typing is one entry. */
  onChange: OnPanelChange;
  /** Back to the dashboard's own settings. */
  onClose: () => void;
  onDuplicate: () => void;
  onSaveAsTemplate: () => void;
  onDelete: () => void;
  /**
   * What the Links section needs (#374): the workspace its targets are
   * listed from, this dashboard, its own variables and the columns this
   * panel's last preview returned.
   */
  links: {
    workspaceId: string;
    dashboardId: string;
    ownVariables: string[];
    resultColumns: string[];
  };
}) {
  const kind = panelKind(panel.viz);
  // A removed source is still what the panel names, so it stays in the list
  // rather than making the control read as some other source's panel.
  const sourceOptions = sources.map((s) => ({ value: s.id, label: s.name }));
  if (sourceMissing && panel.query) {
    sourceOptions.unshift({
      value: panel.query.sourceId,
      label: `${panel.query.sourceId} (removed)`,
    });
  }
  /** A query for a panel switched back from a kind that had none (#202). */
  const starterFor = (viz: VizType) => () => {
    const source = sources[0];
    return starterQuery(source?.id ?? "", source?.catalog ?? null, viz).query;
  };
  /**
   * A new source for the panel. Of the same kind, the query is kept and only
   * re-pointed; of the other kind, its language is wrong there, so the panel
   * starts over from that source's starter for its kind rather than being
   * saved with a query its source cannot run (#388). Undo brings it back.
   */
  const changeSource = (sourceId: string) => {
    const next = sources.find((s) => s.id === sourceId);
    onQueryChange(
      (p) => {
        if (next && sourceKind(next.kind).language !== queryLanguage(p.query)) {
          return { ...p, query: starterQuery(next.id, next.catalog, p.viz).query };
        }
        return { ...p, query: { ...p.query, sourceId } };
      },
      { action: "change panel source" },
    );
  };
  const onQueryChange = (fn: (p: QueryPanel) => Panel, intent: EditIntent) =>
    onChange((p) => (hasQuery(p) ? fn(p) : p), intent);

  return (
    <div>
      <div className="flex items-start justify-between gap-2 pb-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-muted">Panel</p>
          <h2 className="truncate text-base font-semibold">
            {panel.title || "Untitled"}
          </h2>
        </div>
        <div className="flex items-center gap-1">
          <Menu label="Panel actions" trigger={<MoreHorizontal className="h-4 w-4" />}>
            <MenuItem onClick={onDuplicate}>
              <Copy className="h-4 w-4" /> Duplicate
            </MenuItem>
            <MenuItem onClick={onSaveAsTemplate}>
              <LayoutTemplate className="h-4 w-4" /> Save as template…
            </MenuItem>
            <MenuSeparator />
            <MenuItem danger onClick={onDelete}>
              <Trash2 className="h-4 w-4" /> Delete panel
            </MenuItem>
          </Menu>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close panel, show dashboard settings"
            title="Dashboard settings"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {sourceMissing && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          <span>This panel&rsquo;s data source has been removed.</span>
          <Button variant="secondary" size="sm" onClick={onRepoint}>
            Re-point to another source
          </Button>
        </div>
      )}

      <InspectorSection title="Ask AI" defaultOpen>
        {ai}
      </InspectorSection>

      <InspectorSection title={hasQuery(panel) ? "Data" : "Text"} defaultOpen>
        {hasQuery(panel) ? (
          <>
            <div>
              <Label htmlFor="p-source">Source</Label>
              <Select
                id="p-source"
                value={panel.query.sourceId}
                onValueChange={changeSource}
                options={sourceOptions}
              />
            </div>
            <QueryFields
              panel={panel}
              sources={sources}
              timeRange={timeRange}
              variables={variables}
              onChange={onQueryChange}
            />
            <PanelTimingFields
              panel={panel}
              dashboardRange={timeRange}
              dashboardRefreshMs={refreshIntervalMs}
              onChange={onChange}
            />
          </>
        ) : (
          <TextFields panel={panel} onChange={onChange} />
        )}
      </InspectorSection>

      <InspectorSection title="Visualization" defaultOpen>
        <div>
          <Label htmlFor="p-title">Title</Label>
          <Input
            id="p-title"
            value={panel.title}
            onChange={(e) =>
              onChange((p) => ({ ...p, title: e.target.value }), {
                action: "edit panel title",
                key: `${panel.id}:title`,
              })
            }
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="p-viz">Kind</Label>
            <Select
              id="p-viz"
              value={panel.viz}
              onValueChange={(v) =>
                onChange(
                  (p) => changePanelKind(p, v as VizType, starterFor(v as VizType)),
                  {
                    action: "change visualization",
                  },
                )
              }
              options={VIZ_OPTIONS}
            />
          </div>
          {panel.query && (
            <div>
              <Label htmlFor="p-format">Format</Label>
              <Select
                id="p-format"
                value={panel.format ?? ""}
                onValueChange={(v) =>
                  onChange(
                    (p) => ({ ...p, format: v ? (v as Panel["format"]) : undefined }),
                    { action: "change value format" },
                  )
                }
                options={FORMAT_OPTIONS}
              />
            </div>
          )}
        </div>
        {/* A text panel computes nothing; its content is what it says. */}
        {panel.query && (
          <div>
            <Label htmlFor="p-description">Description (what this panel computes)</Label>
            <Textarea
              id="p-description"
              rows={2}
              maxLength={PANEL_DESCRIPTION_MAX}
              placeholder="e.g. Requests per minute, grouped by route"
              value={panel.description ?? ""}
              onChange={(e) =>
                onChange((p) => ({ ...p, description: e.target.value || undefined }), {
                  action: "edit panel description",
                  key: `${panel.id}:description`,
                })
              }
            />
            <p className="mt-1 text-xs text-muted">
              Shown to readers behind the info icon on the panel.
            </p>
          </div>
        )}
      </InspectorSection>

      {/* A text panel's one option, its content, is edited above. */}
      {kind.query === "required" && (
        <InspectorSection title="Display">
          <PanelPresentationFields panel={panel} onChange={onChange} />
        </InspectorSection>
      )}

      {/* Links are not options, and a panel that runs no query takes none. */}
      {kind.query === "required" && (
        <InspectorSection title="Links" defaultOpen={(panel.links?.length ?? 0) > 0}>
          <LinksEditor panel={panel} onChange={onChange} {...links} />
        </InspectorSection>
      )}
    </div>
  );
}

/** The SQL, its preview and its time field: a panel that runs a query. */
function QueryFields({
  panel,
  sources,
  timeRange,
  variables,
  onChange,
}: {
  panel: QueryPanel;
  sources: SourceOption[];
  timeRange: Dashboard["timeRange"];
  variables: VariableValues;
  onChange: (fn: (p: QueryPanel) => Panel, intent: EditIntent) => void;
}) {
  const preview = usePanelPreview(panel, panelTimeRange(panel, timeRange), variables);
  const catalog = sources.find((s) => s.id === panel.query.sourceId)?.catalog ?? null;
  const query = panel.query;

  if (!isSqlQuery(query)) {
    return (
      <PromqlFields
        panel={panel}
        query={query}
        catalog={promqlCatalog(catalog)}
        variables={variables}
        preview={preview}
        onChange={onChange}
      />
    );
  }

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="p-sql">
          SQL (SELECT only; no time filter — the server injects it)
        </Label>
        <SqlEditor
          id="p-sql"
          value={query.sql}
          catalog={sqlCatalog(catalog)}
          onChange={(sql) =>
            onChange((p) => ({ ...p, query: { ...p.query, sql } }), {
              action: "edit SQL",
              key: `${panel.id}:sql`,
            })
          }
          onRun={() => {
            if (preview.busy === null) preview.run();
          }}
          placeholder="SELECT …"
        />
        <PanelPreview panel={panel} preview={preview} />
      </div>

      <TimeFieldPicker
        id="p-tf"
        value={query.timeField}
        sql={query.sql}
        catalog={sqlCatalog(catalog)}
        onChange={(timeField) =>
          onChange((p) => ({ ...p, query: { ...p.query, timeField } }), {
            action: "change time field",
          })
        }
      />
    </>
  );
}

/**
 * A PromQL panel's expression (#388): the editor with metric and label
 * completion and the guard's verdict, then how it is evaluated. There is no
 * time field: the server steps the window itself, and `instant` and
 * `minStep` are the only say a panel has in it.
 */
function PromqlFields({
  panel,
  query,
  catalog,
  variables,
  preview,
  onChange,
}: {
  panel: QueryPanel;
  query: PromqlQuery;
  catalog: ReturnType<typeof promqlCatalog>;
  variables: VariableValues;
  preview: ReturnType<typeof usePanelPreview>;
  onChange: (fn: (p: QueryPanel) => Panel, intent: EditIntent) => void;
}) {
  const setQuery = (patch: Partial<PromqlQuery>, intent: EditIntent) =>
    onChange(
      (p) => (isSqlQuery(p.query) ? p : { ...p, query: { ...p.query, ...patch } }),
      intent,
    );

  // The verdict the editor underlines, from the same route Validate uses.
  const sourceId = query.sourceId;
  const declared = Object.keys(variables).join(",");
  const check = React.useCallback(
    async (promql: string): Promise<PromqlVerdict | null> => {
      const verdict = await validatePanelQuery({
        query: { sourceId, promql },
        variables: declared ? declared.split(",") : [],
      });
      if (verdict.ok) return verdict;
      // A transport failure is not the expression's fault: draw nothing.
      return verdict.error.kind === "statement"
        ? { ok: false, error: verdict.error.error }
        : null;
    },
    [sourceId, declared],
  );

  // `minStep` is a duration; the draft holds what is typed until it is one.
  const [stepDraft, setStepDraft] = React.useState(query.minStep ?? "");
  const stepValid =
    stepDraft.trim() === "" || Duration.safeParse(stepDraft.trim()).success;

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="p-promql">
          PromQL (no range of its own: the server steps the window)
        </Label>
        <PromqlEditor
          id="p-promql"
          value={query.promql}
          catalog={catalog}
          check={check}
          onChange={(promql) =>
            setQuery({ promql }, { action: "edit PromQL", key: `${panel.id}:promql` })
          }
          onRun={() => {
            if (preview.busy === null) preview.run();
          }}
          placeholder="sum(rate(http_requests_total[5m]))"
        />
        <PanelPreview panel={panel} preview={preview} />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Checkbox
            checked={query.instant === true}
            label="Instant (one value per series, at the window's end)"
            onCheckedChange={(instant) =>
              setQuery(
                { instant: instant ? true : undefined },
                { action: "change instant query" },
              )
            }
          />
          <p className="text-xs text-muted">For a stat, a gauge, a table or a pie.</p>
        </div>
        <div>
          <Label htmlFor="p-minstep">Min step</Label>
          <Input
            id="p-minstep"
            placeholder="the server's"
            value={stepDraft}
            disabled={query.instant === true}
            aria-invalid={!stepValid}
            aria-describedby="p-minstep-help"
            onChange={(e) => {
              setStepDraft(e.target.value);
              const next = e.target.value.trim();
              if (next === "" || Duration.safeParse(next).success) {
                setQuery(
                  { minStep: next === "" ? undefined : next },
                  { action: "change min step", key: `${panel.id}:minStep` },
                );
              }
            }}
          />
          <p
            id="p-minstep-help"
            className={stepValid ? "mt-1 text-xs text-muted" : "mt-1 text-xs text-danger"}
          >
            {stepValid
              ? "A floor on the step, such as 1m. The server only ever raises it."
              : "Write a duration such as 30s, 1m or 1h."}
          </p>
        </div>
      </div>
    </>
  );
}

/**
 * A text panel's Markdown (#202), with the panel's own rendering of it as the
 * preview, so what is typed here is what readers get.
 */
function TextFields({ panel, onChange }: { panel: Panel; onChange: OnPanelChange }) {
  const content = typeof panel.options?.content === "string" ? panel.options.content : "";
  return (
    <div className="space-y-2">
      <Label htmlFor="p-content">Text (Markdown)</Label>
      <Textarea
        id="p-content"
        rows={8}
        maxLength={TEXT_CONTENT_MAX}
        className="font-mono text-xs"
        value={content}
        onChange={(e) =>
          onChange((p) => ({ ...p, options: { content: e.target.value } }), {
            action: "edit text",
            key: `${panel.id}:content`,
          })
        }
      />
      <p className="text-xs text-muted">
        Headings, emphasis, lists, code, tables and http(s) or mailto links. HTML is shown
        as text, and images are not loaded.
      </p>
      <div className="max-h-64 overflow-auto border border-border bg-surface p-3">
        {content.trim() ? (
          <MarkdownView source={content} />
        ) : (
          <p className="text-sm text-muted">Nothing to show yet.</p>
        )}
      </div>
    </div>
  );
}
