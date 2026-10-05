"use client";

import * as React from "react";
import { useSyncedDraft } from "@/components/editor/use-synced-draft";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Label } from "@/components/ui/input";
import { DashboardAnnotations } from "@/lib/annotations";
import { describeIssue } from "@/lib/panel-options";

/**
 * Whether this dashboard draws its workspace's annotations, and which (#68).
 * Both default to "all of them", which is a spec with no `annotations` at all.
 */
export function AnnotationSettings({
  value,
  onChange,
}: {
  value: DashboardAnnotations | undefined;
  onChange: (
    next: DashboardAnnotations | undefined,
    action: string,
    key?: string,
  ) => void;
}) {
  const tags = value?.tags ?? [];
  const { draft, setDraft, committed } = useSyncedDraft(tags.join(", "), () =>
    tags.join(", "),
  );
  const [problem, setProblem] = React.useState<string | null>(null);

  function commit(next: DashboardAnnotations) {
    const parsed = DashboardAnnotations.safeParse(next);
    if (!parsed.success) return describeIssue(parsed.error.issues[0]);
    const empty = parsed.data.show !== false && !parsed.data.tags?.length;
    onChange(
      empty ? undefined : parsed.data,
      "change annotation settings",
      "annotations",
    );
    return null;
  }

  return (
    <div className="space-y-3">
      <Checkbox
        checked={value?.show !== false}
        label="Draw annotations on time-series panels"
        onCheckedChange={(show) => {
          setProblem(commit({ ...value, show: show ? undefined : false }));
        }}
      />
      <div>
        <Label htmlFor="annotation-tags-filter">Only these tags (comma-separated)</Label>
        <Input
          id="annotation-tags-filter"
          placeholder="every annotation in the workspace"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            const list = e.target.value
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean);
            const error = commit({ ...value, tags: list.length ? list : undefined });
            setProblem(error);
            if (error === null) committed(list.join(", "));
          }}
        />
        <p className={problem ? "mt-1 text-xs text-danger" : "mt-1 text-xs text-muted"}>
          {problem ??
            "Annotations belong to the workspace; editors add them from the flag on the dashboard, and pipelines post them to the API."}
        </p>
      </div>
    </div>
  );
}
