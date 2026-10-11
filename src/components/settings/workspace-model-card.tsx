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
  type ModelView,
  type WorkspaceModelView,
} from "@/lib/ai/model-config";
import { formatInstant } from "@/lib/time-range";

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

/**
 * One workspace's model (#331), for a source-admin: its own model, of any
 * provider kind (#438), or the server's, and whether people may use their own key here.
 * `serverModel` is the environment's model id, for the line that says what a
 * generation here will use.
 */
export function WorkspaceModelCard({
  initial,
  serverModel,
  allowStub = false,
}: {
  initial: WorkspaceModelView;
  serverModel: string;
  allowStub?: boolean;
}) {
  const display = useTimeDisplay();
  const base = `/api/workspaces/${encodeURIComponent(initial.workspaceId)}/model`;
  const modelsBase = `${base}s`;
  const [view, setView] = React.useState(initial);
  const [useOwn, setUseOwn] = React.useState(initial.config !== null);
  const [allowPersonal, setAllowPersonal] = React.useState(initial.allowPersonalKeys);
  const [draft, setDraft] = React.useState<ModelConfigDraft>(() =>
    draftFromView(initial.config),
  );
  const [status, setStatus] = React.useState<Status>({ kind: "idle" });

  const touch = () => setStatus({ kind: "idle" });

  async function request(url: string, method: string, body?: unknown) {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await readApiError(res)).error);
    return res.json() as Promise<unknown>;
  }

  /**
   * The card edits the workspace's default model (#439): a first save adds
   * one and makes it the default, later saves replace it, and turning it off
   * deletes it, which goes back to the server's model.
   */
  async function save(e: React.FormEvent) {
    e.preventDefault();
    let input = null;
    if (useOwn) {
      const built = inputFromDraft(draft);
      if (!built.ok) {
        setStatus({ kind: "error", message: built.message });
        return;
      }
      input = { ...built.input, name: view.config?.name ?? "Workspace model" };
    }
    setStatus({ kind: "saving" });
    try {
      let defaultModel = view.config ? null : view.defaultModel;
      if (input) {
        const saved = (await request(
          view.config
            ? `${modelsBase}/${encodeURIComponent(view.config.id)}`
            : modelsBase,
          view.config ? "PUT" : "POST",
          input,
        )) as ModelView;
        defaultModel = saved.id;
      } else if (view.config) {
        await request(`${modelsBase}/${encodeURIComponent(view.config.id)}`, "DELETE");
      }
      const next = (await request(base, "PUT", {
        defaultModel,
        allowPersonalKeys: allowPersonal,
      })) as WorkspaceModelView;
      setView(next);
      setUseOwn(next.config !== null);
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
              onChange={(next) => {
                setDraft(next);
                touch();
              }}
              storedKey={view.config?.key}
              testUrl={
                view.config
                  ? `${modelsBase}/${encodeURIComponent(view.config.id)}/test`
                  : `${modelsBase}/test`
              }
              testBody={(input) => input}
              allowStub={allowStub}
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
