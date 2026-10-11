import { notFound } from "next/navigation";
import { getIdentity } from "@/lib/auth/authorize";
import { modelsPageData, modelsPageVisible } from "@/lib/ai/models-page";
import { ModelsClient } from "@/components/models/models-client";
import { SignIn } from "@/components/sign-in";

export const dynamic = "force-dynamic";

/**
 * Models (#441): the server's models, each workspace's the caller generates
 * in, and the caller's own. Visible to anyone who may generate somewhere, and
 * to every visitor in demo mode, where it lists the server's only. Everyone
 * else gets a 404, so hiding the nav link is never the only check; every
 * change goes through routes that check `can()` again.
 */
export default async function ModelsPage() {
  const identity = await getIdentity();
  if (!identity) return <SignIn />;
  if (!modelsPageVisible(identity)) notFound();
  return <ModelsClient data={await modelsPageData(identity)} />;
}
