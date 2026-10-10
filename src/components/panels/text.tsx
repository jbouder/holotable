import * as React from "react";
import type { PanelBodyProps } from "@/components/panels/types";
import { type Align, type Block, type Inline, parseMarkdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";

/**
 * A text panel (#202): its Markdown, through the sanitized subset in
 * `src/lib/markdown.ts`. Every string goes into the tree as a React text
 * node, so nothing in the content is ever interpreted as HTML.
 */
export function TextView({ panel }: PanelBodyProps) {
  const content = typeof panel.options?.content === "string" ? panel.options.content : "";
  return (
    // Focusable, so a keyboard can scroll text longer than its panel, and
    // named, so what took focus is announced (WCAG 2.1.1), as a table is.
    <section
      aria-label={`${panel.title}, text`}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container must be focusable to scroll by keyboard (WCAG 2.1.1)
      tabIndex={0}
      className="h-full overflow-auto focus-visible:outline-2 focus-visible:outline-primary"
    >
      <MarkdownView source={content} />
    </section>
  );
}

/** Rendered Markdown, also the editor's live preview. */
export function MarkdownView({ source }: { source: string }) {
  const blocks = React.useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {blocks.map((block, i) => (
        // Blocks are positional: the content is re-parsed whole on each edit.
        // biome-ignore lint/suspicious/noArrayIndexKey: parsed blocks have no id
        <BlockView key={i} block={block} />
      ))}
    </div>
  );
}

const HEADING_CLASS: Record<number, string> = {
  1: "text-xl font-semibold",
  2: "text-lg font-semibold",
  3: "text-base font-semibold",
  4: "text-sm font-semibold",
  5: "text-sm font-medium",
  6: "text-sm font-medium text-muted",
};

const ALIGN_CLASS: Record<NonNullable<Align>, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case "heading": {
      const Tag = `h${block.level}` as const;
      return (
        <Tag className={HEADING_CLASS[block.level]}>
          <Inlines nodes={block.children} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p>
          <Inlines nodes={block.children} />
        </p>
      );
    case "list": {
      const items = block.items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parsed items have no id
        <li key={i}>
          <Inlines nodes={item} />
        </li>
      ));
      return block.ordered ? (
        <ol className="list-decimal space-y-0.5 pl-5" start={block.start}>
          {items}
        </ol>
      ) : (
        <ul className="list-disc space-y-0.5 pl-5">{items}</ul>
      );
    }
    case "code":
      return (
        <pre className="overflow-auto border border-border bg-surface-2 px-3 py-2 font-mono text-xs">
          {block.text}
        </pre>
      );
    case "quote":
      return (
        <blockquote className="border-l-2 border-border pl-3 text-muted">
          <Inlines nodes={block.children} />
        </blockquote>
      );
    case "rule":
      return <hr className="border-border" />;
    case "table":
      return (
        <div className="overflow-auto">
          <table className="w-max min-w-full text-left text-sm">
            <thead className="bg-surface-2 text-muted">
              <tr>
                {block.header.map((cell, c) => (
                  <th
                    // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                    key={c}
                    className={cn("px-2 py-1 font-medium", alignClass(block.align[c]))}
                  >
                    <Inlines nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
                <tr key={r} className="border-t border-border">
                  {row.map((cell, c) => (
                    <td
                      // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                      key={c}
                      className={cn("px-2 py-1", alignClass(block.align[c]))}
                    >
                      <Inlines nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function alignClass(align: Align | undefined): string | undefined {
  return align ? ALIGN_CLASS[align] : undefined;
}

function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((node, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parsed inlines have no id
        <InlineView key={i} node={node} />
      ))}
    </>
  );
}

function InlineView({ node }: { node: Inline }) {
  switch (node.type) {
    case "text":
      return node.text;
    case "strong":
      return (
        <strong className="font-semibold">
          <Inlines nodes={node.children} />
        </strong>
      );
    case "em":
      return (
        <em>
          <Inlines nodes={node.children} />
        </em>
      );
    case "code":
      return <code className="bg-surface-2 px-1 font-mono text-xs">{node.text}</code>;
    case "link":
      // `href` is an absolute http(s) or mailto URL, or the parser would not
      // have made this a link (`safeHref`).
      return (
        <a
          href={node.href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline underline-offset-2"
        >
          <Inlines nodes={node.children} />
        </a>
      );
  }
}
