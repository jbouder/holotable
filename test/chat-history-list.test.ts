import { test } from "node:test";
import assert from "node:assert/strict";
import {
  entryTitle,
  filterConversations,
  groupConversations,
  readConversationPage,
} from "@/lib/chat/history";

const now = new Date(2026, 9, 10, 15, 0, 0);
const at = (days: number, hours = 0) =>
  new Date(now.getTime() - days * 86_400_000 - hours * 3_600_000).toISOString();
const entry = (id: string, title: string, updatedAt: string) => ({
  id,
  title,
  updatedAt,
  workspaceId: "ws",
  sourceIds: ["src"],
});

test("conversations group into Today, Yesterday and Earlier, newest first", () => {
  const groups = groupConversations(
    [
      entry("a", "old", at(9)),
      entry("b", "this morning", at(0, 5)),
      entry("c", "yesterday", at(1)),
      entry("d", "just now", at(0)),
    ],
    now,
  );
  assert.deepEqual(
    groups.map((g) => [g.group, g.entries.map((e) => e.id)]),
    [
      ["Today", ["d", "b"]],
      ["Yesterday", ["c"]],
      ["Earlier", ["a"]],
    ],
  );
  assert.deepEqual(groupConversations([], now), []);
});

test("the filter matches titles, and an untitled conversation by its placeholder", () => {
  const list = [entry("a", "p95 by route", at(0)), entry("b", "", at(0))];
  assert.deepEqual(
    filterConversations(list, "P95").map((e) => e.id),
    ["a"],
  );
  assert.deepEqual(
    filterConversations(list, "new conv").map((e) => e.id),
    ["b"],
  );
  assert.equal(filterConversations(list, "  ").length, 2);
  assert.equal(entryTitle({ title: "  " }), "New conversation");
});

test("a page from the server is read for its shape only", () => {
  const page = readConversationPage({
    conversations: [
      entry("a", "kept", at(0)),
      { id: 1, title: "bad" },
      { ...entry("b", "x", at(0)), sourceIds: ["s", 2] },
    ],
    next: 7,
  });
  assert.deepEqual(
    page.conversations.map((c) => [c.id, c.sourceIds]),
    [
      ["a", ["src"]],
      ["b", ["s"]],
    ],
  );
  assert.equal(page.next, null);
  assert.deepEqual(readConversationPage(null), { conversations: [], next: null });
});
