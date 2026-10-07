"use client";

import * as React from "react";
import { LayoutGrid, Pencil } from "lucide-react";
import type { Dashboard } from "@/lib/ir";
import { COLUMN_PRESETS } from "@/lib/layout";
import { REFRESH_PRESETS_MS } from "@/lib/panel-options";
import { formatSpan } from "@/lib/time-range";
import type { ApiError } from "@/lib/errors";
import { TimeRangeFilter } from "@/components/dashboard/TimeRangeFilter";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ErrorDisplay } from "@/components/ui/error-display";
import { VariablesEditor } from "@/components/editor/variables-editor";
import { AnnotationSettings } from "@/components/editor/annotation-settings";
import { InspectorSection } from "@/components/editor/InspectorSection";
import type { EditIntent, SourceOption } from "@/components/editor/PanelInspector";

const CUSTOM = "custom";

/**
 * The inspector with no panel selected (#357): everything that belongs to the
 * dashboard rather than to one panel, in one place. The title is edited in
 * the page header, where it reads as the title.
 */
export function DashboardSettings({
  spec,
  sources,
  details,
  variablesError,
  onChange,
  onArrange,
  onEditDetails,
}: {
  spec: Dashboard;
  sources: SourceOption[];
  /** Row metadata: saved on its own, never part of a version (#119). */
  details: { description: string | null; tags: string[] };
  variablesError: ApiError | null;
  onChange: (patch: Partial<Dashboard>, intent: EditIntent) => void;
  onArrange: (columns: number) => void;
  onEditDetails: () => void;
}) {
  return (
    <div>
      <div className="pb-3">
        <p className="text-xs uppercase tracking-wide text-muted">Dashboard</p>
        <h2 className="text-base font-semibold">Settings</h2>
        <p className="mt-1 text-xs text-muted">
          Select a panel on the canvas to edit it.
        </p>
      </div>

      <InspectorSection title="Time and refresh" defaultOpen>
        <div>
          <p className="mb-1 text-sm font-medium text-muted">Time range</p>
          <TimeRangeFilter
            value={spec.timeRange}
            onChange={(timeRange) =>
              onChange({ timeRange }, { action: "change time range" })
            }
          />
          <p className="mt-1 text-xs text-muted">
            What readers see first; the server resolves it on every refresh.
          </p>
        </div>
        <RefreshField
          value={spec.refreshIntervalMs}
          onChange={(refreshIntervalMs, key) =>
            onChange(
              { refreshIntervalMs },
              { action: "change refresh interval", key: key ? "spec:refresh" : null },
            )
          }
        />
      </InspectorSection>

      <InspectorSection title="Layout" defaultOpen>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <LayoutGrid className="h-3.5 w-3.5 text-muted" aria-hidden />
          <span className="mr-1 text-muted">Arrange:</span>
          {COLUMN_PRESETS.map((n) => (
            <Button
              key={n}
              variant="secondary"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => onArrange(n)}
            >
              {n}-up
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted">
          Or drag panels on the canvas and resize them by the corner. A focused panel
          moves with the arrow keys and resizes with Shift; Delete removes it.
        </p>
      </InspectorSection>

      <InspectorSection
        title={`Variables${spec.variables?.length ? ` (${spec.variables.length})` : ""}`}
      >
        <VariablesEditor
          variables={spec.variables}
          sources={sources}
          onChange={(variables, action, key) =>
            onChange({ variables }, { action, key: key ? `spec:${key}` : null })
          }
        />
        {variablesError && <ErrorDisplay error={variablesError} />}
      </InspectorSection>

      <InspectorSection title="Annotations">
        <AnnotationSettings
          value={spec.annotations}
          onChange={(annotations, action, key) =>
            onChange({ annotations }, { action, key: key ? `spec:${key}` : null })
          }
        />
      </InspectorSection>

      <InspectorSection title="Description and tags">
        <p className="text-sm text-foreground">
          {details.description || <span className="text-muted">No description.</span>}
        </p>
        {details.tags.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Tags">
            {details.tags.map((t) => (
              <li key={t} className="border border-border px-2 py-0.5 text-xs text-muted">
                {t}
              </li>
            ))}
          </ul>
        )}
        <Button variant="secondary" size="sm" onClick={onEditDetails}>
          <Pencil className="h-4 w-4" /> Edit description and tags
        </Button>
        <p className="text-xs text-muted">
          Saved as soon as you confirm them, not as part of a version.
        </p>
      </InspectorSection>
    </div>
  );
}

/**
 * Refresh as a choice of presets, with a custom value in seconds for anything
 * else. The server's floor applies to whatever is chosen.
 */
function RefreshField({
  value,
  onChange,
}: {
  value: number;
  /** `typing` coalesces a run of keystrokes in the custom box into one undo step. */
  onChange: (ms: number, typing: boolean) => void;
}) {
  const preset = (REFRESH_PRESETS_MS as readonly number[]).includes(value);
  const [custom, setCustom] = React.useState(!preset);
  const options = [
    ...REFRESH_PRESETS_MS.map((ms) => ({
      value: String(ms),
      label: `every ${formatSpan(ms)}`,
    })),
    { value: CUSTOM, label: "Custom…" },
  ];
  return (
    <div>
      <Label htmlFor="refresh">Refresh</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          id="refresh"
          value={custom ? CUSTOM : String(value)}
          onValueChange={(v) => {
            if (v === CUSTOM) {
              setCustom(true);
              return;
            }
            setCustom(false);
            onChange(Number(v), false);
          }}
          options={options}
        />
        {custom && (
          <div className="flex items-center gap-1.5">
            <Input
              aria-label="Refresh interval in seconds"
              type="number"
              min={1}
              className="w-24"
              value={Math.round(value / 1000)}
              onChange={(e) => {
                const seconds = Number(e.target.value);
                if (Number.isFinite(seconds) && seconds > 0)
                  onChange(seconds * 1000, true);
              }}
            />
            <span className="text-sm text-muted">seconds</span>
          </div>
        )}
      </div>
    </div>
  );
}
