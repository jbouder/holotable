"use client";

import * as React from "react";
import { SqlTextarea } from "@/components/sql/SqlEditor";
import type { LogqlCompletionCatalog } from "@/lib/logql/completion";

/**
 * The panel editor's LogQL field (#565), the same two-part control as
 * `PromqlEditor`: a plain textarea at once, and a CodeMirror editor with
 * LogQL highlighting, label and value completion from the catalog, and the
 * guard's verdict underlined in place, swapped in when its chunk arrives.
 * The catalog is the kind's label allowlist; the editor never learns where
 * the source lives.
 */

/** The guard's answer for one expression, as `/api/sql/validate` gives it. */
export type LogqlVerdict = { ok: true; hints?: string[] } | { ok: false; error: string };

export interface LogqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** The source's labels and their known values, for completion. */
  catalog: LogqlCompletionCatalog | null;
  /** Ask the guard about an expression; its answer is drawn in the editor. */
  check?: (logql: string) => Promise<LogqlVerdict | null>;
  /** Ctrl/⌘ + Enter. */
  onRun?: () => void;
  /** Escape, so the editor never becomes a keyboard trap. */
  onEscape?: () => void;
  id?: string;
  placeholder?: string;
  className?: string;
}

export function LogqlEditor(props: LogqlEditorProps) {
  const [Editor, setEditor] =
    React.useState<React.ComponentType<LogqlEditorProps> | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void import("@/components/logql/LogqlEditorCodeMirror").then(
      (mod) => {
        if (!cancelled) setEditor(() => mod.LogqlEditorCodeMirror);
      },
      () => {
        // The textarea is a complete fallback.
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (!Editor) {
    return (
      <SqlTextarea
        value={props.value}
        onChange={props.onChange}
        catalog={null}
        onRun={props.onRun}
        onEscape={props.onEscape}
        id={props.id}
        placeholder={props.placeholder}
        className={props.className}
      />
    );
  }
  return <Editor {...props} />;
}
