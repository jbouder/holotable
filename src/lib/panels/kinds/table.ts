import { readOptions, TableOptions } from "@/lib/panels/presentation";
import { definePanelKind } from "@/lib/panels/types";

export const table = definePanelKind({
  kind: "table",
  summary: "The result rows as an HTML table.",
  promptHint:
    "rows and columns to read, rather than a shape to see. For only the first or latest N rows, set options.limit to N rather than writing LIMIT in the SQL.",
  promqlHint:
    "an instant query ('instant': true): one row per series, a column per label, then its value.",
  canvas: false,
  timeBrush: false,
  skeleton: "table",
  query: "required",
  options: TableOptions,
  optionGroups: ["table"],
  rowLimit: (options) => readOptions(TableOptions, options).limit,
});
