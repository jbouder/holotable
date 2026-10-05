import { definePanelKind } from "@/lib/panels/types";

export const table = definePanelKind({
  kind: "table",
  summary: "The result rows as an HTML table.",
  promptHint: "rows and columns to read, rather than a shape to see.",
  canvas: false,
  timeBrush: false,
  skeleton: "table",
  query: "required",
});
