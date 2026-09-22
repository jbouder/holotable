"use client";

import * as React from "react";
import type { SourceCatalog } from "@/lib/registry";
import { Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * The panel editor's SQL field.
 *
 * Two implementations of one control. The plain `<textarea>` below renders
 * immediately, works without JavaScript having finished loading, and is what
 * anyone using a screen reader or a keyboard gets if the editor chunk never
 * arrives. The CodeMirror editor — highlighting, bracket matching, catalog
 * completion and the guard's hints underlined in place — is imported on first
 * mount and swapped in when it is ready.
 *
 * Importing it here rather than at the top of the module is what keeps
 * CodeMirror out of the bundle every dashboard *viewer* downloads: nobody
 * reading a dashboard needs a SQL editor. Both spellings are controlled by the
 * same `value`/`onChange`, so the swap cannot lose a keystroke.
 */

export interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** The selected source's tables, for completion and the allowlist hint. */
  catalog: SourceCatalog | null;
  /** Ctrl/⌘ + Enter. */
  onRun?: () => void;
  /** Escape, so the editor never becomes a keyboard trap. */
  onEscape?: () => void;
  id?: string;
  placeholder?: string;
  className?: string;
}

export function SqlEditor(props: SqlEditorProps) {
  const [Editor, setEditor] = React.useState<React.ComponentType<SqlEditorProps> | null>(
    null,
  );

  React.useEffect(() => {
    let cancelled = false;
    void import("@/components/sql/SqlEditorCodeMirror").then(
      (mod) => {
        if (!cancelled) setEditor(() => mod.SqlEditorCodeMirror);
      },
      () => {
        // The textarea below is a complete fallback, so a chunk that fails to
        // load costs the author highlighting, not the ability to write SQL.
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (!Editor) return <SqlTextarea {...props} />;
  return <Editor {...props} />;
}

export function SqlTextarea({
  value,
  onChange,
  onRun,
  onEscape,
  id,
  placeholder,
  className,
}: SqlEditorProps) {
  return (
    <Textarea
      id={id}
      rows={6}
      spellCheck={false}
      placeholder={placeholder}
      className={cn("font-mono", className)}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          onRun?.();
        }
        if (e.key === "Escape") onEscape?.();
      }}
    />
  );
}
