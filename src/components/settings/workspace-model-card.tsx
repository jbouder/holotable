"use client";

import * as React from "react";
import { ModelConfigFields } from "@/components/settings/model-config-fields";
import { useTimeDisplay } from "@/components/time-display";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { apiErrorFromThrown, readApiError } from "@/lib/errors";
import {
  draftFromView,
  inputFromDraft,
  type ModelConfigDraft,
  type WorkspaceModelView,
} from "@/lib/ai/model-config";
import { formatInstant } from "@/lib/time-range";

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

/**
 * One workspace's model (#331), for a source-admin: its own OpenAI-compatible
 * endpoint or the server's, and whether people may use their own key here.
 * `serverModel` is the environment's model id, for the line that says what a
 * generation here will use.
 */
export function WorkspaceModelCard({
  initial,
  serverModel,
}: {
  initial: WorkspaceModelView;
  serverModel: string;
}) {
  const display = useTimeDisplay();
  const base = `/api/workspaces/${encodeURIComponent(initial.workspaceId)}/model`;
  const [view, setView] = React.useState(initial);
  const [useOwn, setUseOwn] = React.useState(initial.config !== null);
  const [allowPersonal, setAllowPersonal] = React.useState(initial.allowPersonalKeys);
  const [draft, setDraft] = React.useState<ModelConfigDraft>(() =>
    draftFromView(initial.config),
  );
  const [status, setStatus] = React.useState<Status>({ kind: "idle" });

  const touch = () => setStatus({ kind: "idle" });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    let config = null;
    if (useOwn) {
      const built = inputFromDraft(draft);
      if (!built.ok) {
        setStatus({ kind: "error", message: built.message });
        return;
      }
      config = built.input;
    }
    setStatus({ kind: "saving" });
    try {
      const res = await fetch(base, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config, allowPersonalKeys: allowPersonal }),
      });
      if (!res.ok) {
        setStatus({ kind: "error", message: (await readApiError(res)).error });
        return;
      }
      const next = (await res.json()) as WorkspaceModelView;
      setView(next);
      setDraft(draftFromView(next.config));
      setStatus({ kind: "saved" });
    } catch (err) {
      setStatus({ kind: "error", message: apiErrorFromThrown(err).error });
    }
  }

  const uses = view.config
    ? `This workspace's model, ${view.config.settings.model}`
    : serverModel
      ? `The server's model, ${serverModel}`
      : "The server's model, which is not configured";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono">{view.workspaceId}</CardTitle>
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <Badge variant="outline">
            {view.config ? "Workspace model" : "Server default"}
          </Badge>
          {view.config &&
            `Updated ${formatInstant(new Date(view.config.updatedAt), display)}`}
        </p>
      </CardHeader>
      <form onSubmit={(e) => void save(e)}>
        <CardContent className="space-y-5 text-sm">
          <p>
            <span className="text-muted">Generations here use: </span>
            {uses}
            {view.allowPersonalKeys && (
              <span className="text-muted">
                , or a person&apos;s own model when they have set one
              </span>
            )}
            .
          </p>
          <Checkbox
            checked={useOwn}
            onCheckedChange={(next) => {
              setUseOwn(next);
              touch();
            }}
            label="Use a model configured for this workspace"
          />
          {useOwn && (
            <ModelConfigFields
              draft={draft}
              onChange={(patch) => {
                setDraft((d) => ({ ...d, ...patch }));
                touch();
              }}
              storedKey={view.config?.key}
              testUrl={`${base}/test`}
              testBody={(input) => input}
            />
          )}
          <Checkbox
            checked={allowPersonal}
            onCheckedChange={(next) => {
              setAllowPersonal(next);
              touch();
            }}
            label="Let people use their own model and key here (Settings → Personal model)"
          />
        </CardContent>
        <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3">
          <Button type="submit" disabled={status.kind === "saving"}>
            {status.kind === "saving" ? "Saving…" : "Save"}
          </Button>
          <p role="status" className="text-xs">
            {status.kind === "saved" && (
              <span className="fade-in text-success">
                Saved. The next generation in this workspace uses it.
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
