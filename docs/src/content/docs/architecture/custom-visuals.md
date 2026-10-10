---
title: Custom visuals
description: Why a view no panel kind draws is a validated Vega-Lite spec rather than code, and what keeps it inside the same boundaries as every other panel.
sidebar:
  order: 7
---

Every panel kind is a decision made at build time: a module in the panel
registry, its renderer, its tests. That keeps each kind safe and consistent,
and it means a view the registry does not have waits for a release. A custom
visual is the escape hatch for that long tail: a slope chart, a band with a
rule, small multiples, a dot plot. It is being built in phases under
[#405](https://github.com/jbouder/holotable/issues/405). This page records
the decision and what the first phase measured.

## The decision

A custom visual is a **Vega-Lite specification**, stored in the panel's
options and drawn over the panel's own query rows. It is a spec, never code.

Vega-Lite is a JSON grammar of graphics with a published schema, and current
models know it well. Its expressions (a `calculate` transform, a `filter`)
are a small expression language that Vega evaluates itself, not JavaScript.
So a stored custom visual can be validated and repaired the way a dashboard
spec is, and the invariants hold as they are.

### Refused alternatives

- **Model-written JavaScript**, even in a sandboxed `<iframe>`. That would be
  code generation (the model generates specs, never code). A stored spec is
  shown to viewers who never trusted its author, share-link and embed viewers
  among them, so code in a spec is stored cross-site scripting. The
  production Content-Security-Policy would refuse to run it anyway. An iframe
  would also lose the single merged chart, the screen-reader table, the PNG
  export, the time brush, drilldown and theming.
- **A raw ECharts option** in the panel's options. It is declarative, but no
  schema bounds it. Its formatters and tooltips are functions, which JSON
  cannot carry. Its colors would bypass the design tokens and the contrast
  checks.

## What keeps a custom visual inside the boundaries

| Boundary | How a custom visual keeps it |
| --- | --- |
| The model generates specs, never data | The spec has no data of its own. The query's rows are bound to it as the one dataset, `rows`. A spec with inline values, other datasets or a URL is refused (phase 2). |
| No code from strings | Vega compiles expressions with `new Function` by default, which the production CSP (`script-src` without `'unsafe-eval'`) refuses. Holotable parses with `ast: true` and evaluates with `vega-interpreter`, which walks the expression tree. A test runs a chart with `Function` itself made to throw, and it is never called. |
| No network | The view's loader refuses every load, so a `data.url`, an image or a link that got past validation fetches nothing. Validation refuses them first (phase 2); the loader is the floor under it. |
| The server is the authority | A spec is compiled on the server wherever one is accepted, so a spec that does not compile is refused with the compiler's message, which is what the repair round needs. |
| Charts merge, never recreate | The view is built once per spec. Each poll replaces the rows with a changeset into the same view. |
| Colors are tokens | A spec names token colors, never literals, and the renderer resolves them from the design tokens in each theme (phase 3). |

Only two modules name Vega: `src/components/charts/vega-runtime.ts` (the view)
and `src/lib/vega/compile.ts` (the compiler). Both import it dynamically, and
`test/vega-runtime.test.ts` fails on any other importer.

## What the first phase measured

Measured on the pinned versions: `vega` 6.4.0, `vega-lite` 6.4.3 and
`vega-interpreter` 2.3.2, all BSD-3-Clause. They add no finding to
`npm audit --omit=dev`.

| Question | Answer |
| --- | --- |
| How much does a page load for its first custom visual? | About 800 KB minified, 270 KB gzipped, as one chunk loaded on demand. A dashboard without a custom visual loads none of it. |
| Does it run under the production CSP? | Yes, with the interpreter. Without it, Vega's default expression compiler is blocked, as the CSP would block it. |
| What does compiling cost on the server? | About 1.3 ms for a three-layer chart (a band, a line per host and a rule). |
| What does drawing cost? | About 14 ms for the first run of that chart over 300 rows, and 3 ms for a poll's changeset. |
| Does a spec that names a URL fetch it? | No. The loader refuses it, and the dataset stays empty. |

Two findings shape the next phases:

- **The import has to be dynamic, on the server too.** Vega-Lite's entry
  imports Vega, and Vega's Node canvas module awaits at its top level. The
  repository's TypeScript runs as CommonJS under the test runner, where a
  static import of that fails. A dynamic import works, and it is what keeps
  the browser chunk separate anyway.
- **Vega-Lite's own messages are uneven.** A bad field type gets a clear one
  ("Invalid field type"). An unknown mark fails inside the compiler with an
  unrelated `TypeError`. The phase 2 validator checks marks, channels and
  types before compiling, so that a refusal names what is wrong.

## Phases

1. The spike and this record: the pinned dependencies, the CSP-safe runtime,
   the server compiler, and their tests.
2. The IR: the `vega` panel kind, the structural walk and its caps, and
   compiling at every acceptance point.
3. The renderer: the lazy chunk, theme config from the tokens, the
   screen-reader table, resize, PNG export, and the axe scan.
4. Generation, chat, repair and the MCP tools, with evals that show the kind
   is chosen only when no registered kind fits.
5. The editor's spec field with compiler messages, the docs, and a
   "Demo custom visuals" dashboard on the demo site.
