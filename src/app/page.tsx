import { redirect } from "next/navigation";
import { getIdentity } from "@/lib/auth/authorize";
import { requestPreferences, startHref } from "@/lib/preferences-server";

export const dynamic = "force-dynamic";

/**
 * Home: the signed-in person's start page (#215), which is also where the OIDC
 * callback lands. A start dashboard that is gone or no longer viewable falls
 * back to the list with a notice. Signed out, the list's own sign-in card.
 */
export default async function Home() {
  const identity = await getIdentity();
  if (!identity) redirect("/dashboards");
  redirect(await startHref(identity, await requestPreferences(identity)));
}
