---
title: Panel options
description: The options each panel kind takes in `panel.options`, and how the three kinds added in M11 read their rows.
sidebar:
  order: 3
---

A panel's `options` belong to its kind. The IR validates them against that
kind's schema (`src/lib/panels/kinds/`), so a gauge's options on a pie panel are
refused, and so is a field a kind does not know. Kinds not listed here take no
options. In the editor, a kind with options gets an **Options (JSON)** box that
is checked as you type.

Colors are always token names, never raw colors:
`success`, `warning`, `danger`, `info`, `neutral`, `orange`, `purple`, `teal`.
They resolve through the same OKLCH values as the theme (invariant 13).

## `gauge`

One value against its limits ([#200](https://github.com/jbouder/holotable/issues/200)).

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `variant` | `"radial"` \| `"bar"` | `"radial"` | A dial for one value, or one horizontal bar per row. |
| `value` | column name | first numeric column | The column shown. |
| `min` | number or column name | `0` | The low limit. A column name reads it from the row. |
| `max` | number or column name | `100` | The high limit. |
| `thresholds` | `[{ value, color }]`, ascending, at most 10 | none | A value takes the color of the last step at or below it. Below the first step, or with none, it is `info`. |

- **`radial`** reads the last row, as `stat` does.
- **`bar`** reads the latest row for each label, where the label is the first
  non-numeric column. Bars are sorted largest first, at most 50.
- A value outside its limits is drawn clamped to them. Its text is always the
  true value, formatted per `panel.format`.

```json
{
  "viz": "gauge",
  "format": "percent",
  "options": {
    "variant": "bar",
    "value": "cpu",
    "thresholds": [
      { "value": 0, "color": "success" },
      { "value": 70, "color": "warning" },
      { "value": 90, "color": "danger" }
    ]
  }
}
```

## `state-timeline`

Discrete states over time, one lane per entity
([#201](https://github.com/jbouder/holotable/issues/201)). Requires
`query.timeField`.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `entity` | column name | first text column other than the state | One lane per value. |
| `state` | column name | last text column | The state of the entity from this row's time. |
| `states` | `[{ state, color }]`, at most 50 | none | A color per state. |
| `variant` | `"spans"` \| `"history"` | `"spans"` | Exact spans, or 40 fixed cells, each in the state that held at its middle. |

The query returns rows of time, entity and state, ordered by time. The spans
are built in the browser from those rows; the model still writes only SQL.

- A span runs from a row's time to the next row's time for the same entity.
  Consecutive rows in the same state are one span.
- Each lane's last span is still open. It ends at the end of the window the
  server resolved, which the stream sends with every `tick`, and never at the
  viewer's clock.
- At most 20 lanes are drawn; the chart says how many more there are.
- A state with no color gets one by name. `up`, `ok` and `healthy` are
  `success`; `down`, `error` and `failed` are `danger`; `warn` and `degraded`
  are `warning`. Any other state gets a fallback color worked out from its
  name, so the same state is always the same color.

## `text`

Markdown, and no query ([#202](https://github.com/jbouder/holotable/issues/202)).

| Option | Type | Meaning |
| --- | --- | --- |
| `content` | string, 1 to 10,000 characters | Required. |

A text panel carries no `query`, and the IR refuses one that does. It is never
executed, has no status badge, and offers no SQL or export. Every part of the
server that reads queries skips it: the poller, saving, re-pointing, export and
import, templates, and chat citations. Because a dashboard's sources decide
its workspace, a dashboard needs at least one panel that is not text.

The content is untrusted, and is rendered as a sanitized subset by
`src/lib/markdown.ts`:
- **Supported:** headings, paragraphs, bold and italic, inline and fenced code,
  lists, block quotes, rules, and pipe tables.
- **Rendered safely:** the Markdown is parsed into a tree and rendered as React
  elements, never as an HTML string, so raw HTML shows as text.
- **Links:** a link keeps its target only when it is an absolute `http(s):` or
  `mailto:` URL, and opens with `rel="noopener noreferrer"`. Anything else,
  including `javascript:`, shows as plain text.
- **Images:** never loaded; an image shows as its alt text.
