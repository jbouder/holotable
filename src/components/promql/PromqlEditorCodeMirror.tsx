"use client";

import * as React from "react";
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  completionStatus,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  bracketMatching,
  indentOnInput,
  LRLanguage,
  LanguageSupport,
  syntaxHighlighting,
} from "@codemirror/language";
import { type Diagnostic, linter, lintKeymap } from "@codemirror/lint";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, keymap, placeholder } from "@codemirror/view";
import { parser } from "@prometheus-io/lezer-promql";
import type { PromqlEditorProps } from "@/components/promql/PromqlEditor";
import { editorHighlight, editorTheme } from "@/components/sql/editor-theme";
import { documentNonce } from "@/lib/csp-nonce";
import {
  type PromqlCompletionCatalog,
  promqlCompletions,
  promqlDiagnostics,
} from "@/lib/promql/completion";

/**
 * The CodeMirror half of {@link PromqlEditor}, built like the SQL editor's:
 * created once, outside text applied as a transaction, the catalog and the
 * check in a compartment so a source change reconfigures without a rebuild,
 * and the page's CSP nonce on its stylesheet.
 *
 * The parser is the one the guard uses (`@prometheus-io/lezer-promql`), so
 * what is highlighted as an expression is what the guard will read as one.
 */

const promqlLanguage = new LanguageSupport(
  LRLanguage.define({ name: "promql", parser, languageData: { closeBrackets: {} } }),
);

type Check = PromqlEditorProps["check"];

function catalogExtensions(
  catalog: PromqlCompletionCatalog | null,
  check: { current: Check },
): Extension {
  return [
    autocompletion({
      override: [
        (context: CompletionContext): CompletionResult | null => {
          if (!catalog) return null;
          const text = context.state.doc.toString();
          const found = promqlCompletions(catalog, text, context.pos);
          if (!found) return null;
          // Only offer on an explicit request or once a word is started.
          if (found.from === context.pos && !context.explicit) return null;
          return { from: found.from, options: found.options, validFor: /^[\w:]*$/ };
        },
      ],
    }),
    linter(
      async (view): Promise<Diagnostic[]> => {
        const text = view.state.doc.toString();
        if (!check.current || text.trim() === "") return [];
        const verdict = await check.current(text);
        // The document may have moved on while the guard answered.
        if (!verdict || view.state.doc.toString() !== text) return [];
        return promqlDiagnostics(text, verdict).map((d) => ({
          ...d,
          source: "holotable",
        }));
      },
      // The guard runs on the server, so this waits for a real pause.
      { delay: 750 },
    ),
  ];
}

export function PromqlEditorCodeMirror({
  value,
  onChange,
  catalog,
  check,
  onRun,
  onEscape,
  id,
  placeholder: placeholderText,
  className,
}: PromqlEditorProps) {
  const host = React.useRef<HTMLDivElement>(null);
  const view = React.useRef<EditorView | null>(null);
  const source = React.useRef(new Compartment());
  const checkRef = React.useRef<Check>(check);
  checkRef.current = check;

  const latest = React.useRef({ value, onChange, onRun, onEscape });
  latest.current = { value, onChange, onRun, onEscape };

  React.useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: latest.current.value,
      extensions: [
        EditorView.cspNonce.of(documentNonce()),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        promqlLanguage,
        syntaxHighlighting(editorHighlight),
        editorTheme,
        EditorView.lineWrapping,
        EditorState.tabSize.of(2),
        placeholderText ? placeholder(placeholderText) : [],
        // No `indentWithTab`: Tab keeps moving focus. Escape is the second way out.
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
              if (completionStatus(v.state) !== null) return false;
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
          "aria-label": "Panel PromQL",
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) latest.current.onChange(update.state.doc.toString());
        }),
        source.current.of([]),
      ],
    });
    const editor = new EditorView({ state, parent: host.current });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [id, placeholderText]);

  React.useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === value) return;
    editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  React.useEffect(() => {
    view.current?.dispatch({
      effects: source.current.reconfigure(catalogExtensions(catalog, checkRef)),
    });
  }, [catalog]);

  return <div ref={host} tabIndex={-1} className={className} />;
}
