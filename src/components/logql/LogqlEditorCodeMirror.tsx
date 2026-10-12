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
import { styleTags, tags } from "@lezer/highlight";
import { parser } from "@grafana/lezer-logql";
import type { LogqlEditorProps } from "@/components/logql/LogqlEditor";
import { editorHighlight, editorTheme } from "@/components/sql/editor-theme";
import { documentNonce } from "@/lib/csp-nonce";
import {
  type LogqlCompletionCatalog,
  logqlCompletions,
  logqlDiagnostics,
} from "@/lib/logql/completion";

/**
 * The CodeMirror half of {@link LogqlEditor}, built like the PromQL editor's:
 * created once, outside text applied as a transaction, the catalog and the
 * check in a compartment so a source change reconfigures without a rebuild,
 * and the page's CSP nonce on its stylesheet.
 *
 * The parser is the one the guard uses (`@grafana/lezer-logql`), so what is
 * highlighted as an expression is what the guard will read as one. That
 * grammar ships no highlighting of its own, so the node names are mapped to
 * the tags `editor-theme.ts` colors here, as the PromQL grammar maps its own.
 */

const logqlHighlight = styleTags({
  LineComment: tags.comment,
  String: tags.string,
  "Number Duration Bytes": tags.number,
  Identifier: tags.variableName,
  "Matcher/Identifier Labels/Identifier LabelName": tags.labelName,
  "CountOverTime Rate RateCounter BytesOverTime BytesRate AvgOverTime SumOverTime MinOverTime MaxOverTime StddevOverTime StdvarOverTime QuantileOverTime FirstOverTime LastOverTime AbsentOverTime LabelReplace Vector":
    tags.function(tags.variableName),
  "Sum Avg Count Max Min Stddev Stdvar Bottomk Topk Sort Sort_Desc": tags.operatorKeyword,
  "Json Logfmt Unpack Pattern Regexp Unwrap LabelFormat LineFormat Decolorize Drop Keep Ip":
    tags.keyword,
  "By Without Bool On Ignoring GroupLeft GroupRight Offset": tags.modifier,
  "And Or Unless": tags.logicOperator,
  "Eq Neq Re Nre PipeExact PipeMatch PipePattern Npa Pipe Gtr Gte Lss Lte Eql Add Sub Mul Div Mod Pow":
    tags.operator,
  "BytesConv DurationConv DurationSecondsConv": tags.function(tags.variableName),
});

const logqlLanguage = new LanguageSupport(
  LRLanguage.define({
    name: "logql",
    parser: parser.configure({ props: [logqlHighlight] }),
    languageData: { closeBrackets: {}, commentTokens: { line: "#" } },
  }),
);

type Check = LogqlEditorProps["check"];

function catalogExtensions(
  catalog: LogqlCompletionCatalog | null,
  check: { current: Check },
): Extension {
  return [
    autocompletion({
      override: [
        (context: CompletionContext): CompletionResult | null => {
          if (!catalog) return null;
          const text = context.state.doc.toString();
          const found = logqlCompletions(catalog, text, context.pos);
          if (!found) return null;
          // Only offer on an explicit request, once a word is started, or
          // inside a matcher's quotes, where a value is what comes next.
          const inValue = found.options.some((o) => o.type === "constant");
          if (found.from === context.pos && !context.explicit && !inValue) return null;
          return {
            from: found.from,
            options: found.options,
            // A value runs to its closing quote; a name is word characters.
            validFor: inValue ? /^[^"]*$/ : /^\w*$/,
          };
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
        return logqlDiagnostics(text, verdict).map((d) => ({
          ...d,
          source: "holotable",
        }));
      },
      // The guard runs on the server, so this waits for a real pause.
      { delay: 750 },
    ),
  ];
}

export function LogqlEditorCodeMirror({
  value,
  onChange,
  catalog,
  check,
  onRun,
  onEscape,
  id,
  placeholder: placeholderText,
  className,
}: LogqlEditorProps) {
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
        logqlLanguage,
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
          "aria-label": "Panel LogQL",
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
