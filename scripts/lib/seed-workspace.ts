import { parseGroups } from "@/lib/auth/claims";
import { DEFAULT_LOCAL_GROUPS, splitGroups } from "@/lib/config";

/** The workspace the seeder fills everywhere but local mode. */
export const DEMO_WORKSPACE = "demo";

/**
 * The workspace the seeder fills and `npm run smoke` reads (#600): the one
 * the local owner can see in local mode, the first workspace `LOCAL_GROUPS`
 * names (`local` by default), and `demo` otherwise, which is the workspace the
 * demo mode's visitors and the local realm's users hold.
 */
export function seedWorkspace(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AUTH_MODE !== "local") return DEMO_WORKSPACE;
  const groups = splitGroups(env.LOCAL_GROUPS || DEFAULT_LOCAL_GROUPS);
  return Object.keys(parseGroups("seed", groups).workspaces)[0] ?? DEMO_WORKSPACE;
}
