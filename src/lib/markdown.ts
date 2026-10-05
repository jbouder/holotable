/**
 * The Markdown a text panel renders (#202), parsed to a small tree.
 *
 * The content is untrusted: a person typed it, or a model wrote it from a
 * prompt, and either way it is shown to every viewer of the dashboard. So
 * this does not produce HTML at all. It produces the tree below, which
 * `src/components/panels/text.tsx` turns into React elements, and React
 * escapes every string it is handed. There is no `dangerouslySetInnerHTML`
 * on this path, which is what makes raw HTML in the source render as the text
 * it is, and what lets the output live under the nonce CSP in `src/proxy.ts`
 * without asking anything of it.
 *
 * The subset is deliberately small: headings, paragraphs, emphasis, inline
 * and fenced code, ordered and unordered lists, block quotes, rules, pipe
 * tables, and links. A link keeps its target only when it is an absolute
 * http(s) or mailto URL; anything else (`javascript:`, `data:`, a relative
 * path) is shown as its text with no link. Images are not loaded from
 * anywhere: one is shown as its alt text.
 *
 * Pure and dependency-free, so it is tested as a function.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] };

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "list"; ordered: boolean; start: number; items: Inline[][] }
  | { type: "code"; text: string }
  | { type: "quote"; children: Inline[] }
  | { type: "rule" }
  | { type: "table"; align: Align[]; header: Inline[][]; rows: Inline[][][] };

/** Schemes a link may keep. Everything else is shown as text. */
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * A link target, if it is one a viewer may be sent to: an absolute http(s) or
 * mailto URL, normalized by the URL parser (so `JaVaScRiPt:` and a scheme
 * smuggled behind whitespace or control characters are caught by the same
 * check as the plain form). Null otherwise.
 */
export function safeHref(raw: string): string | null {
  const trimmed = raw.trim();
  // The URL parser strips tabs and newlines inside a URL; refuse them instead
  // of letting `java\nscript:` normalize into something else.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is being refused
  if (trimmed === "" || /[\u0000-\u001f\u007f\s]/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  return SAFE_PROTOCOLS.has(url.protocol) ? url.href : null;
}

/* -------------------------------------------------------------------------- */
/* Blocks                                                                     */
/* -------------------------------------------------------------------------- */

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?/;
const BULLET = /^\s*[-*+]\s+/;
const ORDERED = /^\s*(\d{1,9})[.)]\s+/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    isTableStart(line, next)
  );
}

function isTableStart(line: string, next: string | undefined): boolean {
  return line.includes("|") && next !== undefined && TABLE_DIVIDER.test(next);
}

/** `| a | b |` as its cells, without the outer pipes. `\|` is a literal pipe. */
function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < row.length; i++) {
    if (row[i] === "\\" && row[i + 1] === "|") {
      current += "|";
      i++;
    } else if (row[i] === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += row[i];
    }
  }
  cells.push(current.trim());
  return cells;
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : null;
}

/** Parse Markdown into blocks. Never throws; anything it does not know is text. */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) {
        body.push(lines[i]);
        i++;
      }
      i++; // the closing fence, or past the end when there is none
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInline(heading[2] ?? ""),
      });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push(lines[i].replace(QUOTE, ""));
        i++;
      }
      blocks.push({ type: "quote", children: parseInline(body.join(" ")) });
      continue;
    }

    const ordered = ORDERED.exec(line);
    if (ordered || BULLET.test(line)) {
      const marker = ordered ? ORDERED : BULLET;
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i];
        if (marker.test(current)) {
          items.push(current.replace(marker, ""));
        } else if (
          current.trim() !== "" &&
          /^\s+/.test(current) &&
          !startsBlock(current.trim(), lines[i + 1])
        ) {
          // A wrapped item: an indented line that starts nothing new.
          items[items.length - 1] += ` ${current.trim()}`;
        } else {
          break;
        }
        i++;
      }
      blocks.push({
        type: "list",
        ordered: ordered !== null,
        start: ordered ? Number(ordered[1]) : 1,
        items: items.map(parseInline),
      });
      continue;
    }

    if (isTableStart(line, lines[i + 1])) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map(alignOf);
      const width = header.length;
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
        const cells = splitRow(lines[i]);
        // As many cells as the header, no more and no fewer.
        rows.push(Array.from({ length: width }, (_, c) => parseInline(cells[c] ?? "")));
        i++;
      }
      blocks.push({
        type: "table",
        align: Array.from({ length: width }, (_, c) => align[c] ?? null),
        header: header.map(parseInline),
        rows,
      });
      continue;
    }

    const body: string[] = [line.trim()];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !startsBlock(lines[i], lines[i + 1])
    ) {
      body.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: "paragraph", children: parseInline(body.join(" ")) });
  }

  return blocks;
}

/* -------------------------------------------------------------------------- */
/* Inlines                                                                    */
/* -------------------------------------------------------------------------- */

/** Characters a backslash makes literal. */
const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|<>~]/;

/** How deep emphasis and links may nest before the rest is taken as text. */
const MAX_DEPTH = 8;

/**
 * Parse one run of inline Markdown. Each opener looks for its closer once;
 * one that has none is literal text, so the work is bounded by the length of
 * the text times the handful of delimiters, never exponential.
 */
export function parseInline(text: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) out.push({ type: "text", text: buffer });
    buffer = "";
  };
  // `indexOf` from a later position can only fail again once it has failed.
  const missing = new Set<string>();
  const find = (needle: string, from: number): number => {
    if (missing.has(needle)) return -1;
    const at = text.indexOf(needle, from);
    if (at === -1) missing.add(needle);
    return at;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === "\\" && i + 1 < text.length && ESCAPABLE.test(text[i + 1])) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }

    if (ch === "`") {
      let run = 1;
      while (text[i + run] === "`") run++;
      const ticks = "`".repeat(run);
      const close = find(ticks, i + run);
      if (close !== -1) {
        flush();
        out.push({ type: "code", text: text.slice(i + run, close).trim() });
        i = close + run;
        continue;
      }
      buffer += ticks;
      i += run;
      continue;
    }

    if (depth < MAX_DEPTH && (ch === "*" || ch === "_")) {
      const double = text[i + 1] === ch;
      const delim = double ? ch + ch : ch;
      // `snake_case_names` are words, not emphasis.
      const wordy = ch === "_" && /\w/.test(text[i - 1] ?? "");
      const close = wordy ? -1 : find(delim, i + delim.length);
      if (close > i + delim.length && text[i + delim.length] !== " ") {
        flush();
        const inner = parseInline(text.slice(i + delim.length, close), depth + 1);
        out.push(
          double ? { type: "strong", children: inner } : { type: "em", children: inner },
        );
        i = close + delim.length;
        continue;
      }
      buffer += delim;
      i += delim.length;
      continue;
    }

    if (depth < MAX_DEPTH && (ch === "[" || (ch === "!" && text[i + 1] === "["))) {
      const image = ch === "!";
      const open = image ? i + 1 : i;
      const mid = find("](", open);
      const close = mid === -1 ? -1 : text.indexOf(")", mid + 2);
      if (mid !== -1 && close !== -1 && !text.slice(open + 1, mid).includes("\n")) {
        flush();
        const label = text.slice(open + 1, mid);
        // `[text](url "title")`: the title is dropped.
        const target =
          text
            .slice(mid + 2, close)
            .trim()
            .split(/\s+/)[0] ?? "";
        const children = parseInline(label, depth + 1);
        const href = image ? null : safeHref(target);
        if (href) out.push({ type: "link", href, children });
        else out.push(...children);
        i = close + 1;
        continue;
      }
    }

    if (ch === "<") {
      const close = find(">", i + 1);
      const href = close === -1 ? null : safeHref(text.slice(i + 1, close));
      if (close !== -1 && href) {
        flush();
        out.push({
          type: "link",
          href,
          children: [{ type: "text", text: text.slice(i + 1, close) }],
        });
        i = close + 1;
        continue;
      }
    }

    buffer += ch;
    i++;
  }
  flush();
  return out;
}

/** The text of an inline run, without its markup: for a title or an alt. */
export function inlineText(nodes: Inline[]): string {
  return nodes
    .map((n) =>
      n.type === "text" || n.type === "code" ? n.text : inlineText(n.children),
    )
    .join("");
}
