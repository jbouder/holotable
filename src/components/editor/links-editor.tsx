"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, Pencil, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { type Panel, PANEL_LINKS_MAX, PanelLink, selfLinkProblems } from "@/lib/ir";
import {
  emptyLinkForm,
  formFromLink,
  type LinkForm,
  type LinkSetRow,
  linkFromForm,
  moveLink,
  type PickSource,
  undeclaredPicks,
} from "@/lib/link-form";
import { describeLink } from "@/lib/panel-diff";
import { z } from "zod";

/**
 * The panel inspector's Links section (#374): where a panel leads, edited
 * without JSON. A target is picked from the dashboards the server lists for
 * this workspace, by title, and stored by the id it came with; a typed id is
 * never taken from the form. The variables a link may set are the target's
 * own, read from its spec, and the columns a pick may read are the ones this
 * panel's last preview returned.
 */

interface SettingsIntent {
  action: string;
  key?: string | null;
}
type OnChange = (fn: (p: Panel) => Panel, intent: SettingsIntent) => void;

/** A dashboard as the target picker lists it. */
interface DashboardHit {
  id: string;
  title: string;
}

async function listDashboards(
  workspaceId: string,
  params: Record<string, string>,
): Promise<DashboardHit[]> {
  const search = new URLSearchParams({ workspaceId, ...params });
  const res = await fetch(`/api/dashboards?${search}`);
  if (!res.ok) return [];
  const body = (await res.json()) as { dashboards?: DashboardHit[] };
  return (body.dashboards ?? []).map((d) => ({ id: d.id, title: d.title }));
}

/** The names a dashboard declares, from its spec, or null when it cannot be read. */
async function variablesOf(id: string): Promise<string[] | null> {
  const res = await fetch(`/api/dashboards/${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  const body = (await res.json()) as {
    dashboard?: { spec?: { variables?: { name: string }[] } };
  };
  return (body.dashboard?.spec?.variables ?? []).map((v) => v.name);
}

function withLinks(panel: Panel, links: PanelLink[]): Panel {
  const { links: _, ...rest } = panel;
  return links.length > 0 ? { ...rest, links } : rest;
}

export function LinksEditor({
  panel,
  onChange,
  workspaceId,
  dashboardId,
  ownVariables,
  resultColumns,
}: {
  panel: Panel;
  onChange: OnChange;
  workspaceId: string;
  /** This dashboard, which "another dashboard" leaves out. */
  dashboardId: string;
  /** The draft's own variables: what a link to this dashboard may set. */
  ownVariables: string[];
  /** The columns this panel's last preview returned. */
  resultColumns: string[];
}) {
  const links = panel.links ?? [];
  const [editing, setEditing] = React.useState<{
    index: number | null;
    form: LinkForm;
  } | null>(null);
  const titles = useTargetTitles(workspaceId, links);

  const commit = (next: PanelLink[], action: string) =>
    onChange((p) => withLinks(p, next), { action });

  return (
    <div className="space-y-3">
      {links.length === 0 && !editing && (
        <p className="text-xs text-muted">
          A link leads from this panel to another dashboard in the workspace, or sets a
          variable on this one. A link that reads a column or the series is followed by
          clicking the data.
        </p>
      )}
      {links.length > 0 && (
        <ul className="space-y-1" aria-label="Links">
          {links.map((link, i) => (
            <li
              key={link.title}
              className="flex items-start gap-1 border border-border px-2 py-1.5 text-sm"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{link.title}</p>
                <p className="text-xs text-muted">
                  {link.dashboard === undefined
                    ? "This dashboard"
                    : (titles[link.dashboard] ?? "A dashboard not in this workspace")}
                  {" · "}
                  {describeLink(link).split("; ").slice(1).join("; ") ||
                    "carries the view"}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Edit link ${link.title}`}
                onClick={() =>
                  setEditing({
                    index: i,
                    form: formFromLink(
                      link,
                      link.dashboard ? titles[link.dashboard] : undefined,
                    ),
                  })
                }
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Move link ${link.title} up`}
                disabled={i === 0}
                onClick={() => commit(moveLink(links, i, i - 1), "reorder links")}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Move link ${link.title} down`}
                disabled={i === links.length - 1}
                onClick={() => commit(moveLink(links, i, i + 1), "reorder links")}
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove link ${link.title}`}
                onClick={() => {
                  if (editing?.index === i) setEditing(null);
                  commit(
                    links.filter((_, j) => j !== i),
                    `remove link ${link.title}`,
                  );
                }}
              >
                <X className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {editing ? (
        <LinkFormFields
          // A different link, or a new one, is a fresh form.
          key={editing.index ?? "new"}
          initial={editing.form}
          workspaceId={workspaceId}
          dashboardId={dashboardId}
          ownVariables={ownVariables}
          resultColumns={resultColumns}
          otherTitles={links.filter((_, j) => j !== editing.index).map((l) => l.title)}
          onCancel={() => setEditing(null)}
          onSave={(link) => {
            const next =
              editing.index === null
                ? [...links, link]
                : links.map((l, j) => (j === editing.index ? link : l));
            commit(
              next,
              editing.index === null
                ? `add link ${link.title}`
                : `edit link ${link.title}`,
            );
            setEditing(null);
          }}
        />
      ) : (
        <Button
          variant="secondary"
          size="sm"
          disabled={links.length >= PANEL_LINKS_MAX}
          title={
            links.length >= PANEL_LINKS_MAX
              ? `A panel has at most ${PANEL_LINKS_MAX} links`
              : undefined
          }
          onClick={() => setEditing({ index: null, form: emptyLinkForm() })}
        >
          <Plus className="h-4 w-4" /> Add link
        </Button>
      )}

      <LinksJson
        key={JSON.stringify(links)}
        links={links}
        ownVariables={ownVariables}
        onApply={(next) => commit(next, "edit links (JSON)")}
      />
    </div>
  );
}

/** The titles of the dashboards a panel's links name, as the server lists them here. */
function useTargetTitles(
  workspaceId: string,
  links: PanelLink[],
): Record<string, string> {
  const ids = [...new Set(links.flatMap((l) => (l.dashboard ? [l.dashboard] : [])))];
  const key = ids.join(",");
  const [titles, setTitles] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (key === "") return;
    let live = true;
    void listDashboards(workspaceId, { id: key }).then((hits) => {
      if (live) setTitles(Object.fromEntries(hits.map((h) => [h.id, h.title])));
    });
    return () => {
      live = false;
    };
  }, [workspaceId, key]);
  return titles;
}

const SOURCE_OPTIONS: { value: PickSource; label: string }[] = [
  { value: "value", label: "a value" },
  { value: "column", label: "a column of the clicked row" },
  { value: "series", label: "the clicked series" },
];

function LinkFormFields({
  initial,
  workspaceId,
  dashboardId,
  ownVariables,
  resultColumns,
  otherTitles,
  onCancel,
  onSave,
}: {
  initial: LinkForm;
  workspaceId: string;
  dashboardId: string;
  ownVariables: string[];
  resultColumns: string[];
  otherTitles: string[];
  onCancel: () => void;
  onSave: (link: PanelLink) => void;
}) {
  const [form, setForm] = React.useState(initial);
  const [problems, setProblems] = React.useState<string[]>([]);
  const targetVariables = useTargetVariables(form.target?.id ?? null, ownVariables);
  const undeclared = undeclaredPicks(form, targetVariables);
  const id = React.useId();
  const update = (patch: Partial<LinkForm>) => setForm((f) => ({ ...f, ...patch }));
  const editRow = (i: number, patch: Partial<LinkSetRow>) =>
    update({ set: form.set.map((r, j) => (j === i ? { ...r, ...patch } : r)) });

  const variableOptions = [
    ...(targetVariables ?? []),
    // A name the target no longer declares stays visible, flagged below.
    ...form.set
      .map((r) => r.name)
      .filter((n) => n && !(targetVariables ?? []).includes(n)),
  ].map((n) => ({ value: n, label: n }));

  return (
    <fieldset className="space-y-3 border border-border p-3">
      <legend className="px-1 text-sm font-medium text-muted">
        {initial.title ? `Edit link ${initial.title}` : "New link"}
      </legend>

      <TargetPicker
        target={form.target}
        workspaceId={workspaceId}
        dashboardId={dashboardId}
        onChange={(target) =>
          update({
            target,
            // A title the author has not written follows the target.
            title:
              form.title === "" || form.title === (form.target?.title ?? "")
                ? (target?.title ?? form.title)
                : form.title,
          })
        }
      />

      <div>
        <Label htmlFor={`${id}-title`}>Title</Label>
        <Input
          id={`${id}-title`}
          value={form.title}
          maxLength={64}
          onChange={(e) => update({ title: e.target.value })}
        />
      </div>

      <div className="space-y-1">
        <Checkbox
          checked={form.carryTimeRange}
          onCheckedChange={(on) => update({ carryTimeRange: on })}
          label="Carry the time range"
        />
        <Checkbox
          checked={form.carryVariables}
          onCheckedChange={(on) => update({ carryVariables: on })}
          label="Carry the variable picks"
        />
        {form.target && (
          <Checkbox
            checked={form.newTab}
            onCheckedChange={(on) => update({ newTab: on })}
            label="Open in a new tab"
          />
        )}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Set on arrival</p>
        {targetVariables !== null && targetVariables.length === 0 && (
          <p className="text-xs text-muted">
            {form.target ? "That dashboard declares" : "This dashboard declares"} no
            variables, so the link can only carry the view.
          </p>
        )}
        {form.set.map((row, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
            key={i}
            className="grid grid-cols-1 gap-2 border-b border-border pb-2 sm:grid-cols-2"
          >
            <Select
              aria-label={`Pick ${i + 1} variable`}
              value={row.name || null}
              placeholder="variable"
              options={variableOptions}
              onValueChange={(name) => editRow(i, { name })}
            />
            <Select
              aria-label={`Pick ${i + 1} from`}
              value={row.source}
              options={SOURCE_OPTIONS}
              onValueChange={(source) =>
                editRow(i, { source: source as PickSource, text: "" })
              }
            />
            {row.source === "value" && (
              <Input
                aria-label={`Pick ${i + 1} value`}
                placeholder="value"
                value={row.text}
                maxLength={256}
                onChange={(e) => editRow(i, { text: e.target.value })}
              />
            )}
            {row.source === "column" &&
              (resultColumns.length > 0 ? (
                <Select
                  aria-label={`Pick ${i + 1} column`}
                  value={row.text || null}
                  placeholder="column"
                  options={[
                    ...resultColumns,
                    ...(row.text && !resultColumns.includes(row.text) ? [row.text] : []),
                  ].map((c) => ({ value: c, label: c }))}
                  onValueChange={(text) => editRow(i, { text })}
                />
              ) : (
                <Input
                  aria-label={`Pick ${i + 1} column`}
                  placeholder="result column (run the preview to list them)"
                  value={row.text}
                  maxLength={128}
                  onChange={(e) => editRow(i, { text: e.target.value })}
                />
              ))}
            <div className="flex justify-end sm:col-span-2">
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove pick ${i + 1}`}
                onClick={() => update({ set: form.set.filter((_, j) => j !== i) })}
              >
                <X className="h-4 w-4" /> Remove
              </Button>
            </div>
          </div>
        ))}
        {undeclared.length > 0 && (
          <p className="text-xs text-warning">
            {form.target ? "That dashboard" : "This dashboard"} does not declare{" "}
            {undeclared.map((n) => `"${n}"`).join(", ")}, so{" "}
            {undeclared.length === 1 ? "it would be" : "they would be"} ignored.
          </p>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={form.set.length >= 10 || targetVariables?.length === 0}
          onClick={() =>
            update({ set: [...form.set, { name: "", source: "value", text: "" }] })
          }
        >
          <Plus className="h-4 w-4" /> Add a pick
        </Button>
      </div>

      {problems.length > 0 && (
        <ul className="space-y-0.5 text-xs text-danger" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => {
            const result = linkFromForm(form, {
              otherTitles,
              ownVariables: new Set(ownVariables),
            });
            setProblems(result.problems);
            if (result.link) onSave(result.link);
          }}
        >
          Save link
        </Button>
      </div>
    </fieldset>
  );
}

/** The variables the link's target declares: the draft's own for this dashboard. */
function useTargetVariables(targetId: string | null, own: string[]): string[] | null {
  const [fetched, setFetched] = React.useState<{
    id: string;
    names: string[] | null;
  } | null>(null);
  React.useEffect(() => {
    if (targetId === null || targetId === "") return;
    let live = true;
    void variablesOf(targetId).then((names) => {
      if (live) setFetched({ id: targetId, names });
    });
    return () => {
      live = false;
    };
  }, [targetId]);
  if (targetId === null) return own;
  return fetched?.id === targetId ? (fetched.names ?? []) : null;
}

/** "This dashboard", or one the server lists for the workspace, found by title. */
function TargetPicker({
  target,
  workspaceId,
  dashboardId,
  onChange,
}: {
  target: { id: string; title: string } | null;
  workspaceId: string;
  dashboardId: string;
  onChange: (target: { id: string; title: string } | null) => void;
}) {
  // An empty id is "another dashboard", not yet picked.
  const another = target !== null;
  const picked = target !== null && target.id !== "" ? target : null;
  const [query, setQuery] = React.useState("");
  const [hits, setHits] = React.useState<DashboardHit[]>([]);
  const id = React.useId();

  React.useEffect(() => {
    if (!another || picked) return;
    let live = true;
    const timer = setTimeout(() => {
      void listDashboards(workspaceId, query.trim() ? { q: query.trim() } : {}).then(
        (h) => {
          if (live) setHits(h.filter((d) => d.id !== dashboardId).slice(0, 8));
        },
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [another, picked, query, workspaceId, dashboardId]);

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium" id={`${id}-target`}>
        Leads to
      </p>
      <div className="flex gap-2" role="radiogroup" aria-labelledby={`${id}-target`}>
        <Button
          size="sm"
          variant={another ? "ghost" : "secondary"}
          role="radio"
          aria-checked={!another}
          onClick={() => onChange(null)}
        >
          This dashboard
        </Button>
        <Button
          size="sm"
          variant={another ? "secondary" : "ghost"}
          role="radio"
          aria-checked={another}
          onClick={() => {
            if (!another) onChange({ id: "", title: "" });
          }}
        >
          Another dashboard
        </Button>
      </div>
      {another &&
        (picked ? (
          <div className="flex items-center justify-between gap-2 border border-border px-2 py-1.5 text-sm">
            <span className="truncate">{picked.title}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onChange({ id: "", title: "" })}
            >
              Change
            </Button>
          </div>
        ) : (
          <div className="space-y-1">
            <Input
              aria-label="Find a dashboard"
              placeholder="Find a dashboard by title"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <ul aria-label="Dashboards" className="max-h-48 overflow-auto">
              {hits.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    className="w-full px-2 py-1.5 text-left text-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-primary"
                    onClick={() => onChange(hit)}
                  >
                    {hit.title}
                  </button>
                </li>
              ))}
              {hits.length === 0 && (
                <li className="px-2 py-1.5 text-xs text-muted">No dashboards match.</li>
              )}
            </ul>
          </div>
        ))}
    </div>
  );
}

const LinksArray = z.array(PanelLink).max(PANEL_LINKS_MAX);

/** The links as JSON, for anything the form does not cover. */
function LinksJson({
  links,
  ownVariables,
  onApply,
}: {
  links: PanelLink[];
  ownVariables: string[];
  onApply: (links: PanelLink[]) => void;
}) {
  const [text, setText] = React.useState(() => JSON.stringify(links, null, 2));
  const [problem, setProblem] = React.useState<string | null>(null);
  const id = React.useId();
  function apply() {
    let raw: unknown;
    try {
      raw = text.trim() === "" ? [] : JSON.parse(text);
    } catch {
      setProblem("That is not valid JSON.");
      return;
    }
    const parsed = LinksArray.safeParse(raw);
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? "Those are not links.");
      return;
    }
    const declared = new Set(ownVariables);
    const self = parsed.data.flatMap((l) => selfLinkProblems(l, declared));
    if (self.length > 0) {
      setProblem(self[0]?.message ?? null);
      return;
    }
    setProblem(null);
    onApply(parsed.data);
  }
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-xs text-muted">Links (JSON)</summary>
      <Textarea
        id={`${id}-json`}
        aria-label="Links as JSON"
        className="mt-2 font-mono text-xs"
        rows={6}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {problem && <p className="mt-1 text-xs text-danger">{problem}</p>}
      <div className="mt-2 flex justify-end">
        <Button size="sm" variant="secondary" onClick={apply}>
          Apply JSON
        </Button>
      </div>
    </details>
  );
}
