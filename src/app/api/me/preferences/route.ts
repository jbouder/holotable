import { z } from "zod";
import { requireIdentity } from "@/lib/auth/authorize";
import { json, readJson, route } from "@/lib/http";
import { audit } from "@/lib/audit";
import { pgConversationStore } from "@/lib/db/conversations";
import { loadPreferences, savePreferences } from "@/lib/preferences-server";

export const runtime = "nodejs";

/**
 * The caller's own preferences (#213). Neither method takes a subject: the row
 * is always the session's own, so nobody, a platform admin included, can read
 * or change another person's.
 */
export const GET = route("me.preferences.get", async () => {
  const identity = await requireIdentity();
  return json(await loadPreferences(identity));
});

/** Merge a partial object of known, valid preferences; 400 names the field. */
export const PATCH = route("me.preferences.patch", async (req: Request) => {
  const identity = await requireIdentity();
  const body = await readJson(req, z.unknown(), { maxBytes: 4_096 });
  const saved = await savePreferences(identity, body);
  // Not keeping conversations (#416) means not keeping the ones already
  // kept: the store is emptied here, on the server, whatever the page did.
  const turnedOff =
    typeof body === "object" &&
    body !== null &&
    (body as Record<string, unknown>).rememberChats === false;
  if (turnedOff && !saved.rememberChats) {
    const deleted = await pgConversationStore.removeAll(identity.sub);
    if (deleted > 0) {
      audit({
        actor: identity,
        action: "chat.delete",
        workspaceId: null,
        detail: { deleted, all: true, rememberChats: false },
      });
    }
  }
  return json(saved);
});
