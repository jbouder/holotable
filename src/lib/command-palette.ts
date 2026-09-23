import type { SourceRecord } from "@/lib/registry";
import type { Theme } from "@/lib/theme";

/**
 * What the command palette can offer and how it decides the order.
 *
 * Everything here is pure: the palette component fetches, navigates and reads
 * `localStorage`; this module only turns a payload and a query into a ranked
 * list. That is what makes the matching testable, and it is why the actions are
 * *data* — a tagged union the component switches on — rather than callbacks a
 * list could not be compared or ranked.
 *
 * Authorization is NOT here. The palette lists what `GET /api/search` returned,
 * and that route only ever answers with rows the identity can already reach;
 * ranking cannot add a row, only reorder the ones it was handed.
 */

export type CommandKind = "dashboard" | "source" | "page" | "action";

export type CommandAction =
  | { type: "navigate"; href: string }
  | { type: "theme"; theme: Theme }
  | { type: "refresh-catalog"; sourceId: string; name: string };

export interface Command {
  /** Stable across renders and across sessions — it is what "recent" records. */
  id: string;
  kind: CommandKind;
  title: string;
  /** The second line: a workspace, a description of what the action does. */
  subtitle?: string;
  /** Extra words that should match but are not worth showing. */
  keywords?: string;
  action: CommandAction;
}

/** Sections, in the order they are shown. */
export const SECTIONS: { kind: CommandKind; label: string }[] = [
  { kind: "dashboard", label: "Dashboards" },
  { kind: "source", label: "Data sources" },
  { kind: "page", label: "Pages" },
  { kind: "action", label: "Actions" },
];

/** At most this many of any one kind, so one section cannot bury the others. */
export const PER_SECTION = 6;

/** How many recently-used commands are remembered. */
export const MAX_RECENTS = 5;

/**
 * The commands that exist regardless of what is in the database.
 *
 * Every one of them is an ordinary authorized route: the palette is a faster
 * way to reach a page, never a way around the check on it. "New data source"
 * lands on `/data-sources`, which shows nothing to an identity that administers
 * no workspace.
 */
export const STATIC_COMMANDS: Command[] = [
  {
    id: "page:dashboards",
    kind: "page",
    title: "Dashboards",
    keywords: "list home",
    action: { type: "navigate", href: "/dashboards" },
  },
  {
    id: "page:explore",
    kind: "page",
    title: "Explore",
    keywords: "query ad hoc sql",
    action: { type: "navigate", href: "/explore" },
  },
  {
    id: "page:data-sources",
    kind: "page",
    title: "Data sources",
    keywords: "connections catalog",
    action: { type: "navigate", href: "/data-sources" },
  },
  {
    id: "action:new-dashboard",
    kind: "action",
    title: "New dashboard",
    subtitle: "Describe it and the model writes the spec",
    keywords: "create add generate",
    action: { type: "navigate", href: "/dashboards/new" },
  },
  {
    id: "action:new-source",
    kind: "action",
    title: "New data source",
    subtitle: "Connect a TimescaleDB or PostgreSQL database",
    keywords: "create add connect",
    action: { type: "navigate", href: "/data-sources?new=1" },
  },
  {
    id: "action:theme-dark",
    kind: "action",
    title: "Theme: dark",
    keywords: "appearance colour color",
    action: { type: "theme", theme: "dark" },
  },
  {
    id: "action:theme-light",
    kind: "action",
    title: "Theme: light",
    keywords: "appearance colour color",
    action: { type: "theme", theme: "light" },
  },
  {
    id: "action:theme-system",
    kind: "action",
    title: "Theme: system",
    keywords: "appearance colour color auto",
    action: { type: "theme", theme: "system" },
  },
];

/** What `GET /api/search` answers with. Deliberately not a source record. */
export interface SearchResults {
  dashboards: { id: string; title: string; workspaceId: string }[];
  sources: { id: string; name: string; workspaceId: string; canManage: boolean }[];
}

export const EMPTY_RESULTS: SearchResults = { dashboards: [], sources: [] };

/**
 * A source row as the palette may see it.
 *
 * An allowlist rather than a spread, and a named function rather than an inline
 * `.map` in the route, so the thing invariant 5 forbids is testable: a
 * `SourceRecord` carries the host, port, database, credentials reference and
 * the whole catalog, and none of it belongs in a search result. Nothing is
 * copied here that the palette does not draw.
 */
export function projectSource(
  source: SourceRecord,
  canManage: boolean,
): SearchResults["sources"][number] {
  return {
    id: source.id,
    name: source.name,
    workspaceId: source.workspaceId,
    canManage,
  };
}

/**
 * Turn a search payload into commands.
 *
 * A source is reached by anchor rather than by a route of its own: there is no
 * per-source page, and inventing a URL the app does not serve would be a dead
 * link in a list whose whole job is getting somewhere. Refreshing a catalog is
 * offered only where the payload says the identity may manage the source —
 * which the route it posts to checks again for itself.
 */
export function commandsFromResults(results: SearchResults): Command[] {
  const dashboards = results.dashboards.map(
    (d): Command => ({
      id: `dashboard:${d.id}`,
      kind: "dashboard",
      title: d.title,
      subtitle: d.workspaceId,
      action: { type: "navigate", href: `/dashboards/${d.id}` },
    }),
  );
  const sources = results.sources.flatMap((s): Command[] => {
    const open: Command = {
      id: `source:${s.id}`,
      kind: "source",
      title: s.name,
      subtitle: s.workspaceId,
      action: { type: "navigate", href: `/data-sources#source-${s.id}` },
    };
    if (!s.canManage) return [open];
    return [
      open,
      {
        id: `refresh:${s.id}`,
        kind: "action",
        title: `Refresh catalog for ${s.name}`,
        subtitle: s.workspaceId,
        keywords: "introspect schema tables columns",
        action: { type: "refresh-catalog", sourceId: s.id, name: s.name },
      },
    ];
  });
  return [...dashboards, ...sources];
}

const BOUNDARY = /[\s\-_/:.]/;

/**
 * How well `text` matches `query` as a subsequence, or `null` for no match.
 *
 * Higher is better. Consecutive characters, a match at the start, and a match
 * after a separator all score; distance skipped between matches costs. An
 * empty query matches everything at zero, which is what lets the same function
 * serve the list shown before anything is typed.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (q === "") return 0;
  const t = text.toLowerCase();

  let score = 0;
  let cursor = 0;
  let run = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const at = t.indexOf(ch, cursor);
    if (at === -1) return null;
    if (at === cursor && cursor > 0) {
      run += 1;
      score += 8 + run * 2;
    } else {
      run = 0;
      score += 1;
      // Skipping a long way to find the next character is a weaker match, but
      // the penalty is capped so a late match still beats no match.
      score -= Math.min(at - cursor, 8) * 0.5;
    }
    if (at === 0) score += 12;
    else if (BOUNDARY.test(t[at - 1] ?? "")) score += 6;
    cursor = at + 1;
  }
  // Among equally-matched titles the shorter one is the one that was meant.
  return score - t.length * 0.05;
}

/** The subtitle and keywords match too, at a discount — they are context, not the name. */
export function scoreCommand(command: Command, query: string): number | null {
  const title = fuzzyScore(query, command.title);
  const secondary = [command.subtitle, command.keywords]
    .filter((s): s is string => Boolean(s))
    .map((s) => fuzzyScore(query, s))
    .filter((s): s is number => s !== null);
  const best = Math.max(
    title ?? Number.NEGATIVE_INFINITY,
    ...secondary.map((s) => s / 3),
  );
  return Number.isFinite(best) ? best : null;
}

const KIND_ORDER: Record<CommandKind, number> = {
  dashboard: 0,
  source: 1,
  page: 2,
  action: 3,
};

/**
 * The list to show, in the order to show it.
 *
 * With nothing typed, recently-used commands lead and the rest keep their
 * declared order — the palette opens on "what you did last", which is the whole
 * reason to remember them. With something typed, the score decides and a recent
 * command only wins ties, because "I used this yesterday" should not outrank
 * "this is what you just spelled".
 */
export function rankCommands(
  commands: Command[],
  query: string,
  recentIds: string[] = [],
): Command[] {
  const recency = new Map(recentIds.map((id, i) => [id, recentIds.length - i]));
  const trimmed = query.trim();

  if (trimmed === "") {
    const recent = recentIds
      .map((id) => commands.find((c) => c.id === id))
      .filter((c): c is Command => c !== undefined);
    const rest = commands.filter((c) => !recency.has(c.id));
    return capPerSection([...recent, ...rest]);
  }

  const scored = commands
    .map((command) => ({ command, score: scoreCommand(command, trimmed) }))
    .filter((s): s is { command: Command; score: number } => s.score !== null)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (recency.get(b.command.id) ?? 0) - (recency.get(a.command.id) ?? 0) ||
        KIND_ORDER[a.command.kind] - KIND_ORDER[b.command.kind] ||
        a.command.title.localeCompare(b.command.title),
    );
  return capPerSection(scored.map((s) => s.command));
}

function capPerSection(commands: Command[]): Command[] {
  const seen = new Map<CommandKind, number>();
  return commands.filter((c) => {
    const n = (seen.get(c.kind) ?? 0) + 1;
    seen.set(c.kind, n);
    return n <= PER_SECTION;
  });
}

/**
 * Split a ranked list into sections without reordering it: a section's position
 * is fixed, but within one the ranking is preserved, and an empty section is
 * left out rather than rendered as a heading over nothing.
 */
export function groupCommands(
  commands: Command[],
): { kind: CommandKind; label: string; commands: Command[] }[] {
  return SECTIONS.map(({ kind, label }) => ({
    kind,
    label,
    commands: commands.filter((c) => c.kind === kind),
  })).filter((section) => section.commands.length > 0);
}

/** Most recent first, no duplicates, bounded. */
export function pushRecent(
  recents: string[],
  id: string,
  max: number = MAX_RECENTS,
): string[] {
  return [id, ...recents.filter((r) => r !== id)].slice(0, max);
}

export const RECENTS_STORAGE_KEY = "command-palette-recents";

/**
 * Recents come out of `localStorage`, which anything on the origin can write,
 * so the value is treated as untrusted: anything that is not an array of short
 * strings is discarded, and an id that names nothing simply matches nothing in
 * `rankCommands`. A remembered id can name a command, never reach one.
 */
export function parseRecents(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (v): v is string => typeof v === "string" && v.length > 0 && v.length <= 200,
      )
      .slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}
