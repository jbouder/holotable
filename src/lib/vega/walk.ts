import { OKLCH_PALETTE } from "@/lib/color/oklch";
import { COLOR_TOKENS } from "@/lib/panels/colors";

/**
 * The structural walk every custom visual's Vega-Lite spec passes (#405,
 * phase 2), on plain JSON. It imports no Vega, so the IR runs it anywhere a
 * panel is parsed: the browser, the server, the model's output schema.
 *
 * It refuses what would let a spec reach past its panel, and checks the names
 * Vega-Lite's own compiler reports badly:
 *
 * - **Data.** Every `data` is exactly `{ "name": "rows" }`, and the top level
 *   has one: the panel's query rows are the only data a spec sees (the model
 *   generates specs, never data). `datasets` is refused.
 * - **Network and the page.** `url`, `href`, `usermeta`, a parameter bound to
 *   a page `element`, and an `image` mark are refused anywhere. The runtime's
 *   loader refuses every URL as well; this is the first wall, that the floor.
 * - **Theme.** `config` is refused, and every color is a token name
 *   (`danger`, `info`, …), a chart color (`palette-0` to `palette-5`) or
 *   `transparent`: the renderer resolves them in the viewer's theme. A
 *   `scheme` is refused for the same reason.
 * - **Size.** At most {@link VEGA_SPEC_MAX_BYTES} serialized and
 *   {@link VEGA_SPEC_MAX_DEPTH} levels deep, as every other spec field is
 *   capped.
 * - **Names.** Marks and field types are checked against the lists below, so
 *   a typo is refused with a message that names it, and a spec with no view
 *   (no mark, layer or composition) is refused as drawing nothing: the
 *   compiler's own messages for these are unrelated `TypeError`s.
 *
 * Each issue is `{ path, message }`, the path from the spec's root, for the
 * IR to report as zod issues under `options.spec`.
 */

export const VEGA_SPEC_MAX_BYTES = 32 * 1024;
export const VEGA_SPEC_MAX_DEPTH = 24;
export const VEGA_DATA = { name: "rows" } as const;

const MARKS = new Set([
  "arc",
  "area",
  "bar",
  "boxplot",
  "circle",
  "errorband",
  "errorbar",
  "line",
  "point",
  "rect",
  "rule",
  "square",
  "text",
  "tick",
  "trail",
]);

const FIELD_TYPES = new Set(["quantitative", "temporal", "ordinal", "nominal"]);

/** Keys refused wherever they appear, and why. */
const REFUSED: Record<string, string> = {
  datasets: "a custom visual reads only the panel's rows; inline datasets are refused",
  url: "a custom visual cannot load a URL",
  href: "a custom visual cannot link out; use a panel link (drilldown) instead",
  usermeta: "usermeta is refused",
  config: "a custom visual takes the dashboard's theme; config is refused",
  element: "a parameter cannot bind to an element outside the panel",
  scheme: "color schemes are refused; name token colors in a scale's range",
  projection: "map projections are not supported",
};

const VEGA_LITE_SCHEMA =
  /^https:\/\/vega\.github\.io\/schema\/vega-lite\/v\d+(\.\d+)*\.json$/;

/** The color names a spec may use: tokens, chart colors by index, transparent. */
export const VEGA_COLOR_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(COLOR_TOKENS),
  ...OKLCH_PALETTE.map((_, i) => `palette-${i}`),
  "transparent",
]);

const COLOR_KEYS = new Set(["color", "fill", "stroke", "background"]);
const isColorKey = (key: string) => COLOR_KEYS.has(key) || /[a-z]Color$/.test(key);

export interface VegaIssue {
  path: (string | number)[];
  message: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function sameData(value: unknown): boolean {
  return (
    isObject(value) && Object.keys(value).length === 1 && value.name === VEGA_DATA.name
  );
}

/** Everything wrong with a spec, in walk order. Empty means it may be compiled. */
export function vegaLiteIssues(spec: unknown): VegaIssue[] {
  const issues: VegaIssue[] = [];
  if (!isObject(spec)) {
    return [{ path: [], message: "a Vega-Lite spec is a JSON object" }];
  }
  const bytes = new TextEncoder().encode(JSON.stringify(spec)).length;
  if (bytes > VEGA_SPEC_MAX_BYTES) {
    return [
      {
        path: [],
        message: `the spec is ${bytes} bytes; a custom visual is at most ${VEGA_SPEC_MAX_BYTES}`,
      },
    ];
  }
  if (!sameData(spec.data)) {
    issues.push({
      path: ["data"],
      message: 'the spec reads the panel\'s rows: "data" must be {"name": "rows"}',
    });
  }
  const views = ["mark", "layer", "facet", "repeat", "concat", "hconcat", "vconcat"];
  if (!views.some((k) => k in spec)) {
    issues.push({
      path: [],
      message: `the spec draws nothing: give it one of ${views.join(", ")}`,
    });
  }
  for (const composed of ["facet", "repeat"]) {
    if (composed in spec && !("spec" in spec)) {
      issues.push({
        path: [composed],
        message: `a ${composed} draws its "spec" once per cell: give it one`,
      });
    }
  }
  const schema = spec.$schema;
  if (
    schema !== undefined &&
    (typeof schema !== "string" || !VEGA_LITE_SCHEMA.test(schema))
  ) {
    issues.push({ path: ["$schema"], message: "only a Vega-Lite $schema is accepted" });
  }

  const color = (value: unknown, path: (string | number)[]) => {
    if (typeof value === "string" && !VEGA_COLOR_NAMES.has(value)) {
      issues.push({
        path,
        message: `"${value}" is not a token color; use one of ${[...VEGA_COLOR_NAMES].join(", ")}`,
      });
    }
  };

  const walk = (
    node: unknown,
    path: (string | number)[],
    depth: number,
    inColor: boolean,
  ): void => {
    if (depth > VEGA_SPEC_MAX_DEPTH) {
      issues.push({
        path,
        message: `the spec nests deeper than ${VEGA_SPEC_MAX_DEPTH} levels`,
      });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => {
        walk(item, [...path, i], depth + 1, inColor);
      });
      return;
    }
    if (!isObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      const at = [...path, key];
      if (key in REFUSED) {
        issues.push({ path: at, message: REFUSED[key] ?? key });
        continue;
      }
      if (key === "data" && path.length > 0 && !sameData(value)) {
        issues.push({ path: at, message: 'every "data" is {"name": "rows"}' });
        continue;
      }
      if (key === "mark") {
        const type =
          typeof value === "string" ? value : isObject(value) ? value.type : undefined;
        if (typeof type !== "string" || !MARKS.has(type)) {
          issues.push({
            path: typeof value === "string" ? at : [...at, "type"],
            message: `"${String(type)}" is not a mark this panel draws; use one of ${[...MARKS].join(", ")}`,
          });
        }
      }
      if (
        key === "type" &&
        ("field" in node || "aggregate" in node || "timeUnit" in node)
      ) {
        if (typeof value !== "string" || !FIELD_TYPES.has(value)) {
          issues.push({
            path: at,
            message: `"${String(value)}" is not a field type; use one of ${[...FIELD_TYPES].join(", ")}`,
          });
        }
      }
      if (isColorKey(key)) {
        color(value, at);
        walk(value, at, depth + 1, true);
        continue;
      }
      if (inColor && key === "value") color(value, at);
      if (inColor && key === "range" && Array.isArray(value)) {
        value.forEach((v, i) => {
          color(v, [...at, i]);
        });
      }
      walk(value, at, depth + 1, inColor && key !== "legend");
    }
  };
  walk(spec, [], 0, false);
  return issues;
}
