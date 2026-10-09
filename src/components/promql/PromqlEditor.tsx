"use client";

import * as React from "react";
import { SqlTextarea } from "@/components/sql/SqlEditor";
import type { PromqlCompletionCatalog } from "@/lib/promql/completion";

/**
 * The panel editor's PromQL field (#388), the same two-part control as
 * `SqlEditor`: a plain textarea at once, and a CodeMirror editor with PromQL
 * highlighting, metric and label completion from the catalog, and the
 * guard's verdict underlined in place, swapped in when its chunk arrives.
 * The catalog is the kind's listing of metrics and labels; the editor never
 * learns where the source lives.
 */

/** The guard's answer for one expression, as `/api/sql/validate` gives it. */
export type PromqlVerdict = { ok: true; hints?: string[] } | { ok: false; error: string };

export interface PromqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** The source's metrics and their labels, for completion. */
  catalog: PromqlCompletionCatalog | null;
  /** Ask the guard about an expression; its answer is drawn in the editor. */
  check?: (promql: string) => Promise<PromqlVerdict | null>;
  /** Ctrl/⌘ + Enter. */
  onRun?: () => void;
  /** Escape, so the editor never becomes a keyboard trap. */
  onEscape?: () => void;
  id?: string;
  placeholder?: string;
  className?: string;
}

export function PromqlEditor(props: PromqlEditorProps) {
  const [Editor, setEditor] =
    React.useState<React.ComponentType<PromqlEditorProps> | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void import("@/components/promql/PromqlEditorCodeMirror").then(
      (mod) => {
        if (!cancelled) setEditor(() => mod.PromqlEditorCodeMirror);
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
