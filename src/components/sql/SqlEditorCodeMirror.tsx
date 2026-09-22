"use client";

import * as React from "react";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  completionStatus,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { type Diagnostic, linter, lintKeymap } from "@codemirror/lint";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, keymap, placeholder } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { SqlEditorProps } from "@/components/sql/SqlEditor";
import { documentNonce } from "@/lib/csp-nonce";
import type { SourceCatalog } from "@/lib/registry";
import { catalogCompletions } from "@/lib/sql/completion";
import { sqlHints } from "@/lib/sql/hints";

/**
 * The CodeMirror half of {@link SqlEditor}. Loaded on demand; never imported
 * from a module a dashboard viewer reaches.
 *
 * Three things are deliberate here.
 *
 * The view is created once and kept in a ref, like the chart wrapper. Text
 * arriving from outside (a natural-language edit rewriting the panel) is
 * applied as a transaction against the current document rather than by
 * rebuilding the editor, so the cursor, selection and undo history survive.
 *
 * The catalog lives in a {@link Compartment}. Changing the panel's source
 * reconfigures completion and the hint linter in place — again, no rebuild,
 * no lost history.
 *
 * The stylesheet CodeMirror builds at runtime carries the page's CSP nonce, or
 * the browser drops it; `src/lib/csp-nonce.ts` explains where that comes from.
 *
 * Colors are the app's own tokens, referenced as CSS variables rather than
 * resolved. The tokens are redefined under `[data-theme="light"]`, so an
 * editor that names the variable follows the theme toggle with no work and no
 * second theme to maintain. (ECharts needs the OKLCH values converted because
 * a canvas cannot read a CSS variable; the DOM can.)
 */

const theme = EditorView.theme({
  "&": {
    fontSize: "0.8125rem",
    color: "var(--foreground)",
    backgroundColor: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
  },
  "&.cm-focused": { outline: "2px solid var(--primary)", outlineOffset: "-1px" },
  ".cm-content": {
    fontFamily: "var(--font-mono)",
    padding: "0.5rem 0",
    caretColor: "var(--foreground)",
  },
  ".cm-line": { padding: "0 0.75rem" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--surface-2)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--surface-2)",
    outline: "1px solid var(--primary)",
  },
  ".cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket": {
    color: "var(--danger)",
  },
  ".cm-placeholder": { color: "var(--muted)" },
  ".cm-tooltip": {
    backgroundColor: "var(--surface-2)",
    border: "1px solid var(--border)",
    borderRadius: "calc(var(--radius) - 0.25rem)",
    color: "var(--foreground)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--surface)",
    color: "var(--foreground)",
  },
  ".cm-completionDetail": { color: "var(--muted)", fontStyle: "normal" },
  ".cm-diagnostic-error": { borderLeftColor: "var(--danger)" },
});

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--primary)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--success)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--warning)" },
  { tag: tags.comment, color: "var(--muted)", fontStyle: "italic" },
  { tag: [tags.operator, tags.punctuation, tags.separator], color: "var(--muted)" },
  { tag: tags.typeName, color: "var(--foreground)" },
  { tag: tags.function(tags.variableName), color: "var(--foreground)" },
]);

/** Completion and the hint linter, both of which depend on the source. */
function catalogExtensions(catalog: SourceCatalog | null): Extension {
  const completions = catalog ? catalogCompletions(catalog) : null;
  return [
    sql({
      dialect: PostgreSQL,
      upperCaseKeywords: true,
      ...(completions
        ? { schema: completions.schema, defaultSchema: completions.defaultSchema }
        : {}),
    }),
    linter(
      (view): Diagnostic[] =>
        sqlHints(view.state.doc.toString(), catalog).map((hint) => ({
          from: hint.from,
          to: hint.to,
          severity: "error",
          source: "holotable",
          message: hint.message,
        })),
      // The guard is the authority and it runs on Validate; this is a
      // background hint, so it waits for a pause in typing.
      { delay: 400 },
    ),
  ];
}

export function SqlEditorCodeMirror({
  value,
  onChange,
  catalog,
  onRun,
  onEscape,
  id,
  placeholder: placeholderText,
  className,
}: SqlEditorProps) {
  const host = React.useRef<HTMLDivElement>(null);
  const view = React.useRef<EditorView | null>(null);
  const source = React.useRef(new Compartment());

  // Everything the editor is built from once is read through a ref, so that a
  // new closure or a new catalog object on a later render cannot rebuild it.
  const latest = React.useRef({ value, onChange, onRun, onEscape });
  latest.current = { value, onChange, onRun, onEscape };

  React.useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: latest.current.value,
      extensions: [
        // Without this the editor's stylesheet is blocked and it renders as
        // unstyled text. See `documentNonce`.
        EditorView.cspNonce.of(documentNonce()),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        syntaxHighlighting(highlight),
        theme,
        EditorView.lineWrapping,
        EditorState.tabSize.of(2),
        placeholderText ? placeholder(placeholderText) : [],
        // No `indentWithTab`: Tab has to keep moving focus, or the editor
        // becomes a keyboard trap. Escape is the second way out.
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              latest.current.onRun?.();
              return true;
            },
          },
          {
            key: "Escape",
            run: (v) => {
              // While a completion is open, Escape belongs to it.
              if (completionStatus(v.state) !== null) return false;
              // Focus the wrapper rather than dropping to the document body,
              // so the next Tab continues into the form instead of starting
              // over at the top of the page.
              host.current?.focus();
              latest.current.onEscape?.();
              return true;
            },
          },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...completionKeymap,
          ...lintKeymap,
        ]),
        EditorView.contentAttributes.of({
          ...(id ? { id } : {}),
          "aria-label": "Panel SQL",
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            latest.current.onChange(update.state.doc.toString());
          }
        }),
        // Filled by the catalog effect below, which runs immediately after
        // this one and on every later source change.
        source.current.of([]),
      ],
    });
    const editor = new EditorView({ state, parent: host.current });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // Built once. The document, the catalog and the callbacks are applied by
    // the effects below and by `latest`; rebuilding on any of them would throw
    // away the cursor and the undo history mid-edit.
  }, [id, placeholderText]);

  // Text that arrived from somewhere other than typing — a natural-language
  // edit, or switching panels — replaces the document without rebuilding.
  React.useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === value) return;
    editor.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  React.useEffect(() => {
    view.current?.dispatch({
      effects: source.current.reconfigure(catalogExtensions(catalog)),
    });
  }, [catalog]);

  // `tabIndex={-1}` makes the wrapper focusable by script (for Escape) without
  // adding a second stop to the tab order; the editor itself is reached by Tab
  // because a `contenteditable` element is already in it.
  return <div ref={host} tabIndex={-1} className={className} />;
}
