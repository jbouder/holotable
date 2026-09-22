"use server";

import { cookies } from "next/headers";
import { DISMISSAL_MAX_AGE_SECONDS, DISMISSIBLE, isDismissed } from "@/lib/dismissals";

/**
 * Record — or undo — a dismissal for this browser.
 *
 * A server action rather than `document.cookie` so the flag can be `httpOnly`
 * and so the only code that writes it is on the server, next to the code that
 * reads it. `name` arrives from the browser like any other request body, so it
 * is checked against the two names the flow owns rather than trusted; the
 * return value says what was actually stored.
 */
export async function dismissHint(name: string, dismissed: boolean): Promise<boolean> {
  if (!DISMISSIBLE.has(name)) return false;
  const jar = await cookies();
  if (dismissed) {
    jar.set(name, "1", {
      path: "/",
      maxAge: DISMISSAL_MAX_AGE_SECONDS,
      sameSite: "lax",
      httpOnly: true,
    });
  } else {
    jar.delete(name);
  }
  return isDismissed(jar.get(name)?.value) === dismissed;
}
