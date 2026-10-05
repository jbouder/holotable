import { audit } from "@/lib/audit";
import { apiTokenHash, generateApiToken } from "@/lib/auth/api-token";
import { assertAuthorized, HttpError, requireIdentity } from "@/lib/auth/authorize";
import { apiTokenRequest, apiTokenView } from "@/lib/api-token-view";
import { config } from "@/lib/config";
import { pgApiTokenStore } from "@/lib/db/api-tokens";
import { json, readJson, route } from "@/lib/http";
import { WorkspaceId } from "@/lib/workspace-limits";

export const runtime = "nodejs";

/**
 * The workspace in the path, for managing its service-account tokens (#288):
 * `source:manage` there, which no token can hold, so a token never manages
 * tokens.
 */
async function managedWorkspace(id: string) {
  const identity = await requireIdentity();
  const workspaceId = WorkspaceId.safeParse(id);
  if (!workspaceId.success) throw new HttpError(400, "invalid workspace id");
  assertAuthorized(
    identity,
    "source:manage",
    { workspaceId: workspaceId.data },
    { type: "workspace", id: workspaceId.data },
  );
  return { identity, workspaceId: workspaceId.data };
}

/** The workspace's tokens, without the tokens themselves. */
export const GET = route(
  "workspaces.tokens.list",
  async (_req: Request, ctx: RouteContext<"/api/workspaces/[id]/tokens">) => {
    const { id } = await ctx.params;
    const { workspaceId } = await managedWorkspace(id);
    const tokens = await pgApiTokenStore.list(workspaceId);
    return json({ tokens: tokens.map(apiTokenView), maxDays: config.apiTokenMaxDays });
  },
);

/** Create a token. The plaintext is in this response and nowhere else. */
export const POST = route(
  "workspaces.tokens.create",
  async (req: Request, ctx: RouteContext<"/api/workspaces/[id]/tokens">) => {
    const { id } = await ctx.params;
    const { identity, workspaceId } = await managedWorkspace(id);
    const body = await readJson(req, apiTokenRequest(config.apiTokenMaxDays), {
      maxBytes: 1_024,
    });
    const token = generateApiToken();
    const record = await pgApiTokenStore.create({
      workspaceId,
      name: body.name,
      tokenHash: await apiTokenHash(token),
      role: body.role,
      createdBy: identity.sub,
      expiresAt: new Date(Date.now() + body.expiresInDays * 86_400_000).toISOString(),
    });
    audit({
      actor: identity,
      action: "token.create",
      workspaceId,
      resource: { type: "workspace", id: workspaceId },
      detail: {
        tokenId: record.id,
        name: record.name,
        role: record.role,
        expiresAt: record.expiresAt,
      },
    });
    return json({ token, record: apiTokenView(record) }, { status: 201 });
  },
);
