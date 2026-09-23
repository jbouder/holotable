import { z } from "zod";
import { requireIdentity } from "@/lib/auth/authorize";
import { json, readJson, route } from "@/lib/http";
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
  return json(await savePreferences(identity, body));
});
