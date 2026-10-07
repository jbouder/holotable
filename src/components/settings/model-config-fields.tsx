"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { apiErrorFromThrown, readApiError } from "@/lib/errors";
import {
  describeKey,
  inputFromDraft,
  type KeyState,
  MODEL_CONFIG_LIMITS,
  type ModelConfigDraft,
  type ModelConfigInput,
  type OpenAiApi,
} from "@/lib/ai/model-config";
import type { ModelTestResult } from "@/lib/ai/model-test-result";

const API_OPTIONS = [
  { value: "responses", label: "Responses API (/responses)" },
  { value: "chat", label: "Chat Completions (/chat/completions)" },
];

type TestStatus =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "done"; result: ModelTestResult }
  | { kind: "error"; message: string };

/**
 * The fields of one OpenAI-compatible model configuration (#331), shared by
 * the workspace and personal settings pages, with "Test connection". The key
 * field is write-only: it starts empty whatever is stored, and blank keeps
 * the stored key. `testBody` wraps the input in what the page's test route
 * expects.
 */
export function ModelConfigFields({
  draft,
  onChange,
  storedKey,
  testUrl,
  testBody,
  disabled,
}: {
  draft: ModelConfigDraft;
  onChange: (patch: Partial<ModelConfigDraft>) => void;
  storedKey: KeyState | undefined;
  /** Null hides "Test connection", when there is nowhere to admit the call. */
  testUrl: string | null;
  testBody: (input: ModelConfigInput) => unknown;
  disabled?: boolean;
}) {
  const id = React.useId();
  const [test, setTest] = React.useState<TestStatus>({ kind: "idle" });
  const hasKey = storedKey?.state === "set" || storedKey?.state === "unreadable";

  async function runTest() {
    const built = inputFromDraft(draft);
    if (!built.ok) {
      setTest({ kind: "error", message: built.message });
      return;
    }
    if (!testUrl) return;
    setTest({ kind: "testing" });
    try {
      const res = await fetch(testUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testBody(built.input)),
      });
      if (!res.ok) {
        setTest({ kind: "error", message: (await readApiError(res)).error });
        return;
      }
      setTest({ kind: "done", result: (await res.json()) as ModelTestResult });
    } catch (err) {
      setTest({ kind: "error", message: apiErrorFromThrown(err).error });
    }
  }

  const change = (patch: Partial<ModelConfigDraft>) => {
    setTest({ kind: "idle" });
    onChange(patch);
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">
        Any endpoint that speaks the OpenAI API: OpenAI, OpenRouter, Groq, Together,
        Ollama, vLLM, LM Studio.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor={`${id}-base`}>Base URL</Label>
          <Input
            id={`${id}-base`}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            maxLength={MODEL_CONFIG_LIMITS.baseUrl}
            placeholder="https://openrouter.ai/api/v1"
            value={draft.baseUrl}
            onChange={(e) => change({ baseUrl: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor={`${id}-model`}>Model</Label>
          <Input
            id={`${id}-model`}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            maxLength={MODEL_CONFIG_LIMITS.model}
            placeholder="openai/gpt-4o-mini"
            value={draft.model}
            onChange={(e) => change({ model: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor={`${id}-api`}>API</Label>
          <Select
            id={`${id}-api`}
            className="w-full"
            disabled={disabled}
            value={draft.api}
            options={API_OPTIONS}
            onValueChange={(v) => change({ api: v as OpenAiApi })}
          />
        </div>
        <div>
          <Label htmlFor={`${id}-key`}>API key</Label>
          <Input
            id={`${id}-key`}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            disabled={disabled || draft.clearKey}
            maxLength={MODEL_CONFIG_LIMITS.apiKey}
            placeholder={hasKey ? "Leave blank to keep the stored key" : "sk-…"}
            value={draft.apiKey}
            onChange={(e) => change({ apiKey: e.target.value })}
            aria-describedby={`${id}-key-state`}
          />
          <p
            id={`${id}-key-state`}
            className={
              storedKey?.state === "unreadable"
                ? "mt-1 text-xs text-warning"
                : "mt-1 text-xs text-muted"
            }
          >
            {describeKey(storedKey)} Never shown again after it is saved.
          </p>
          {hasKey && (
            <Checkbox
              className="mt-2"
              disabled={disabled}
              checked={draft.clearKey}
              onCheckedChange={(clearKey) => change({ clearKey, apiKey: "" })}
              label="Remove the stored key (for an endpoint that needs none)"
            />
          )}
        </div>
      </div>
      {testUrl && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled || test.kind === "testing"}
            onClick={() => void runTest()}
          >
            {test.kind === "testing" && (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            )}
            Test connection
          </Button>
          <p role="status" className="text-xs">
            {test.kind === "done" && test.result.ok && (
              <span className="fade-in text-success">
                Connected: {test.result.model || draft.model} answered in{" "}
                {test.result.latencyMs} ms.
              </span>
            )}
            {test.kind === "done" && !test.result.ok && (
              <span className="fade-in text-danger">{test.result.message}</span>
            )}
            {test.kind === "error" && (
              <span className="fade-in text-danger">{test.message}</span>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
