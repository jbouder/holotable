import { HighlightStyle } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

/**
 * The look both query editors share (SQL and PromQL, #388): the app's own
 * tokens as CSS variables, so the editors follow the theme toggle with no
 * second theme to maintain. Only the lazily loaded editors import this, so
 * CodeMirror stays out of the bundle a dashboard viewer downloads.
 */

export const editorTheme = EditorView.theme({
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
    borderRadius: "var(--radius)",
    color: "var(--foreground)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--surface)",
    color: "var(--foreground)",
  },
  ".cm-completionDetail": { color: "var(--muted)", fontStyle: "normal" },
  ".cm-diagnostic-error": { borderLeftColor: "var(--danger)" },
  ".cm-diagnostic-warning": { borderLeftColor: "var(--warning)" },
});

export const editorHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--primary)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--success)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--warning)" },
  { tag: tags.comment, color: "var(--muted)", fontStyle: "italic" },
  { tag: [tags.operator, tags.punctuation, tags.separator], color: "var(--muted)" },
  { tag: tags.typeName, color: "var(--foreground)" },
  { tag: tags.function(tags.variableName), color: "var(--foreground)" },
  // PromQL's (#388): aggregations read as keywords, label names as properties.
  {
    tag: [tags.operatorKeyword, tags.modifier, tags.logicOperator],
    color: "var(--primary)",
  },
  { tag: tags.labelName, color: "var(--foreground)", fontStyle: "italic" },
]);
