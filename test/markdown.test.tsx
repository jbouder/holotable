import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PanelView } from "@/components/dashboard/PanelView";
import { MarkdownView } from "@/components/panels/text";
import { Panel } from "@/lib/ir";
import { type Block, parseMarkdown, safeHref } from "@/lib/markdown";
import { mount } from "./support/dom";

/*
 * The text panel (#202): the Markdown subset, and the guarantee that matters
 * most about it, that nothing in the content runs.
 */

const html = (source: string) => renderToStaticMarkup(<MarkdownView source={source} />);

test("the subset: headings, emphasis, lists, code, quotes, rules, tables, links", () => {
  const blocks = parseMarkdown(
    [
      "# Title",
      "",
      "Some **bold**, *em* and `code`, with a [link](https://example.com/run).",
      "",
      "- one",
      "- two",
      "  wrapped",
      "",
      "3. three",
      "4. four",
      "",
      "```",
      "SELECT 1",
      "```",
      "",
      "> quoted",
      "",
      "---",
      "",
      "| a | b |",
      "|:--|--:|",
      "| 1 | 2 |",
    ].join("\n"),
  );
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["heading", "paragraph", "list", "list", "code", "quote", "rule", "table"],
  );
  const list = blocks[2] as Extract<Block, { type: "list" }>;
  assert.equal(list.items.length, 2, "a wrapped line stays in its item");
  const ordered = blocks[3] as Extract<Block, { type: "list" }>;
  assert.equal(ordered.start, 3);
  const table = blocks[7] as Extract<Block, { type: "table" }>;
  assert.deepEqual(table.align, ["left", "right"]);

  const out = html("Some **bold** and [a link](https://example.com/run).");
  assert.match(out, /<strong[^>]*>bold<\/strong>/);
  assert.match(
    out,
    /<a href="https:\/\/example.com\/run" target="_blank" rel="noopener noreferrer"/,
  );
});

test("raw HTML is shown as text, never parsed", () => {
  for (const source of [
    "<script>alert(1)</script>",
    '<img src=x onerror="alert(1)">',
    '<a href="javascript:alert(1)">x</a>',
    "<iframe src=https://evil.example></iframe>",
    "**<b onmouseover=alert(1)>bold</b>**",
    "| <script>x</script> | b |\n|---|---|\n| 1 | 2 |",
  ]) {
    const out = html(source);
    assert.doesNotMatch(out, /<(script|img|iframe|b )/i, source);
    // An attribute would be `onerror="…"`; as text, its quote is escaped.
    assert.doesNotMatch(out, /\son\w+="/i, source);
    assert.match(out, /&lt;/, `${source} is shown as text`);
  }
});

test("a link keeps its target only when it is http(s) or mailto", () => {
  const unsafe = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    " javascript:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "/relative/path",
    "//evil.example",
    "",
  ];
  for (const href of unsafe) {
    assert.equal(safeHref(href), null, JSON.stringify(href));
    const out = html(`[click](${href})`);
    assert.doesNotMatch(out, /<a /, JSON.stringify(href));
    assert.match(out, /click/, "the text is kept");
  }
  assert.equal(safeHref("https://example.com"), "https://example.com/");
  assert.equal(safeHref("mailto:oncall@example.com"), "mailto:oncall@example.com");
  assert.match(html("<https://example.com>"), /<a href="https:\/\/example.com\/"/);
  assert.doesNotMatch(html("<javascript:alert(1)>"), /<a /);
});

test("an image is never loaded: it is shown as its alt text", () => {
  const out = html("![the graph](https://evil.example/pixel.png)");
  assert.doesNotMatch(out, /<img|evil\.example/);
  assert.match(out, /the graph/);
});

test("escapes, snake_case and unmatched markers stay literal", () => {
  assert.match(html("a \\*not em\\* b"), /a \*not em\* b/);
  assert.match(html("use host_name_here"), /host_name_here/);
  assert.match(html("2 * 3 = 6"), /2 \* 3 = 6/);
});

test("hostile input finishes quickly", () => {
  for (const source of [
    "[".repeat(10_000),
    "*".repeat(10_000),
    "`".repeat(10_000),
    "<".repeat(10_000),
    "**a ".repeat(2_500),
    "> ".repeat(5_000),
  ]) {
    const started = performance.now();
    parseMarkdown(source);
    assert.ok(
      performance.now() - started < 1_000,
      `${source.slice(0, 8)}… took too long`,
    );
  }
});

let harness: Awaited<ReturnType<typeof mount>> | null = null;
afterEach(() => {
  harness?.unmount();
  harness = null;
});

// Whether it offers SQL is a menu item, and Base UI's menu popup does not
// mount under jsdom (see test/panel-actions.test.tsx); PanelView gates it on
// `hasQuery`, as it does the status badge asserted here.
test("a text panel renders at once, with no query or status", async () => {
  const panel = Panel.parse({
    id: "t",
    title: "About",
    viz: "text",
    options: { content: "## Runbook\n\nPage the **DB on-call** if this goes red." },
    layout: { x: 0, y: 0, w: 6, h: 2 },
  });
  harness = await mount();
  harness.render(<PanelView panel={panel} />);
  const text = harness.text();
  assert.match(text, /Runbook/);
  assert.match(text, /DB on-call/);
  assert.equal(harness.container.querySelector(".skeleton"), null, "no loading skeleton");
  assert.doesNotMatch(text, /Loading|live/i, "no status badge");
});
