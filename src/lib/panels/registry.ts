import { gauge } from "@/lib/panels/kinds/gauge";
import { heatmap } from "@/lib/panels/kinds/heatmap";
import { histogram } from "@/lib/panels/kinds/histogram";
import { logs } from "@/lib/panels/kinds/logs";
import { donut, pie } from "@/lib/panels/kinds/pie";
import { scatter } from "@/lib/panels/kinds/scatter";
import { area, bar, line } from "@/lib/panels/kinds/series";
import { stat } from "@/lib/panels/kinds/stat";
import { stateTimeline } from "@/lib/panels/kinds/state-timeline";
import { statusGrid } from "@/lib/panels/kinds/status-grid";
import { table } from "@/lib/panels/kinds/table";
import { text } from "@/lib/panels/kinds/text";
import type { PanelKind } from "@/lib/panels/types";

/**
 * The panel registry (#61): every kind a panel can be, in one list.
 *
 * `VizType` in `src/lib/ir.ts`, the generation prompt's viz list, the editor's
 * picker and the generated docs page are all derived from this list, and its
 * order is theirs. The renderers are the other half, keyed by the same names
 * in `src/components/panels/registry.ts`, where the compiler refuses a kind
 * without one.
 *
 * Registration is an import, not a lookup at runtime: there is no way to add a
 * kind without a build, and so nothing a request can load.
 *
 * Adding a kind is a module under `kinds/`, one line here, its renderer, and
 * one line in the renderer registry.
 */
export const PANEL_KINDS = [
  line,
  area,
  bar,
  scatter,
  stat,
  table,
  heatmap,
  pie,
  donut,
  gauge,
  stateTimeline,
  statusGrid,
  histogram,
  logs,
  text,
] as const satisfies readonly PanelKind[];

/** The name of a registered kind: the type of `panel.viz`. */
export type PanelKindName = (typeof PANEL_KINDS)[number]["kind"];

/** The registered names, in order, as `z.enum` takes them. */
export const PANEL_KIND_NAMES = PANEL_KINDS.map((k) => k.kind) as [
  PanelKindName,
  ...PanelKindName[],
];

const BY_NAME: ReadonlyMap<string, PanelKind> = new Map(
  PANEL_KINDS.map((k) => [k.kind, k]),
);

/** A registered kind by name. */
export function panelKind(name: PanelKindName): PanelKind<PanelKindName> {
  // Every `PanelKindName` is in the map by construction.
  return BY_NAME.get(name) as PanelKind<PanelKindName>;
}

/**
 * A kind by a name that may not be one: a partial spec still streaming from
 * the model, or a value read from somewhere the IR has not validated.
 */
export function findPanelKind(name: unknown): PanelKind<PanelKindName> | undefined {
  return typeof name === "string"
    ? (BY_NAME.get(name) as PanelKind<PanelKindName> | undefined)
    : undefined;
}
