"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ModelConfigFields } from "@/components/settings/model-config-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiErrorFromThrown, readApiError } from "@/lib/errors";
import {
  draftFromView,
  type EffectiveModel,
  inputFromDraft,
  MODEL_SOURCE_LABELS,
  type ModelConfigDraft,
  type ModelConfigView,
} from "@/lib/ai/model-config";

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "removed" }
  | { kind: "error"; message: string };

/**
 * The signed-in person's own model (#331). It applies only in the workspaces
 * listed, the ones that allow personal keys; each row says what a generation
 * of theirs there will use, as of the last page load.
 */
export function PersonalModelCard({
  initial,
  workspaces,
}: {
  initial: ModelConfigView | null;
  workspaces: Array<{ workspaceId: string; effective: EffectiveModel }>;
}) {
  const router = useRouter();
  const [view, setView] = React.useState(initial);
  const [draft, setDraft] = React.useState<ModelConfigDraft>(() =>
    draftFromView(initial),
  );
  const [status, setStatus] = React.useState<Status>({ kind: "idle" });
  const testWorkspace = workspaces[0]?.workspaceId;

  async function send(method: "PUT" | "DELETE", body?: unknown) {
    setStatus({ kind: "saving" });
    try {
      const res = await fetch("/api/me/model", {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        setStatus({ kind: "error", message: (await readApiError(res)).error });
        return;
      }
      if (method === "DELETE") {
        setView(null);
        setDraft(draftFromView(null));
        setStatus({ kind: "removed" });
        router.refresh();
        return;
      }
      const next = ((await res.json()) as { config: ModelConfigView | null }).config;
      setView(next);
      setDraft(draftFromView(next));
      setStatus({ kind: "saved" });
      // The "Where it applies" list is the server's answer; ask again.
      router.refresh();
    } catch (err) {
      setStatus({ kind: "error", message: apiErrorFromThrown(err).error });
    }
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    const built = inputFromDraft(draft);
    if (!built.ok) {
      setStatus({ kind: "error", message: built.message });
      return;
    }
    void send("PUT", built.input);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your model</CardTitle>
        <p className="text-xs text-muted">
          {view
            ? `Set: ${view.settings.model}`
            : "Not set; you use each workspace's model."}
        </p>
      </CardHeader>
      <form onSubmit={save}>
        <CardContent className="space-y-5 text-sm">
          <ModelConfigFields
            draft={draft}
            onChange={(patch) => {
              setDraft((d) => ({ ...d, ...patch }));
              setStatus({ kind: "idle" });
            }}
            storedKey={view?.key}
            testUrl={testWorkspace ? "/api/me/model/test" : null}
            testBody={(config) => ({ config, workspaceId: testWorkspace })}
          />
          <div>
            <p className="mb-2 text-sm font-medium text-muted">Where it applies</p>
            {workspaces.length === 0 ? (
              <p className="text-xs text-muted">
                No workspace you generate in allows personal models yet. A source-admin
                turns it on under Settings → Workspace model.
              </p>
            ) : (
              <ul className="space-y-1">
                {workspaces.map(({ workspaceId, effective }) => (
                  <li key={workspaceId} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono">{workspaceId}</span>
                    <Badge variant="outline">
                      {MODEL_SOURCE_LABELS[effective.source]}
                    </Badge>
                    <span className="text-xs text-muted">
                      {effective.unavailable ?? effective.model}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
        <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3">
          <Button type="submit" disabled={status.kind === "saving"}>
            {status.kind === "saving" ? "Saving…" : "Save"}
          </Button>
          {view && (
            <Button
              type="button"
              variant="ghost"
              disabled={status.kind === "saving"}
              onClick={() => void send("DELETE")}
            >
              Remove my model
            </Button>
          )}
          <p role="status" className="text-xs">
            {status.kind === "saved" && (
              <span className="fade-in text-success">
                Saved. Your next generation in the workspaces above uses it.
              </span>
            )}
            {status.kind === "removed" && (
              <span className="fade-in text-success">
                Removed. You use each workspace&apos;s model again.
              </span>
            )}
            {status.kind === "error" && (
              <span className="fade-in text-danger">{status.message}</span>
            )}
          </p>
        </div>
      </form>
    </Card>
  );
}
