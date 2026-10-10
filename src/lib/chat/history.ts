/**
 * Chat's history list (#416), as pure functions the side panel draws from:
 * grouping by day, the title filter, and how an untitled conversation reads.
 * Browser-safe.
 */

export interface ConversationEntry {
  id: string;
  title: string;
  sourceIds: string[];
  workspaceId: string;
  updatedAt: string;
}

export type HistoryGroup = "Today" | "Yesterday" | "Earlier";

/** A conversation's name in the list: its title, or what it is before one. */
export function entryTitle(entry: Pick<ConversationEntry, "title">): string {
  return entry.title.trim() || "New conversation";
}

/** Newest activity first, in Today / Yesterday / Earlier, by the viewer's clock. */
export function groupConversations(
  entries: readonly ConversationEntry[],
  now: Date = new Date(),
): { group: HistoryGroup; entries: ConversationEntry[] }[] {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const groups: Record<HistoryGroup, ConversationEntry[]> = {
    Today: [],
    Yesterday: [],
    Earlier: [],
  };
  const sorted = [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const entry of sorted) {
    const at = new Date(entry.updatedAt);
    const group: HistoryGroup =
      at >= startOfToday ? "Today" : at >= startOfYesterday ? "Yesterday" : "Earlier";
    groups[group].push(entry);
  }
  return (["Today", "Yesterday", "Earlier"] as const)
    .map((group) => ({ group, entries: groups[group] }))
    .filter((g) => g.entries.length > 0);
}

/** Case-insensitive "contains" over titles, on what is loaded. */
export function filterConversations(
  entries: readonly ConversationEntry[],
  text: string,
): ConversationEntry[] {
  const needle = text.trim().toLowerCase();
  if (!needle) return [...entries];
  return entries.filter((e) => entryTitle(e).toLowerCase().includes(needle));
}

/** A page of the list as the server sent it, trusted no further than its shape. */
export function readConversationPage(body: unknown): {
  conversations: ConversationEntry[];
  next: string | null;
} {
  const record = (typeof body === "object" && body !== null ? body : {}) as {
    conversations?: unknown;
    next?: unknown;
  };
  const list = Array.isArray(record.conversations) ? record.conversations : [];
  return {
    conversations: list.flatMap((c) => {
      const e = c as Partial<ConversationEntry>;
      return typeof e.id === "string" &&
        typeof e.title === "string" &&
        typeof e.updatedAt === "string" &&
        typeof e.workspaceId === "string" &&
        Array.isArray(e.sourceIds)
        ? [
            {
              id: e.id,
              title: e.title,
              updatedAt: e.updatedAt,
              workspaceId: e.workspaceId,
              sourceIds: e.sourceIds.filter((s): s is string => typeof s === "string"),
            },
          ]
        : [];
    }),
    next: typeof record.next === "string" ? record.next : null,
  };
}
