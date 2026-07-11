import { z } from "zod";
import { config } from "@/lib/config";
import { readJson, json } from "@/lib/http";
import { errorResponse, HttpError } from "@/lib/auth/authorize";
import { signSessionToken } from "@/lib/auth/session";
import { setSessionCookie } from "@/lib/auth/cookie";

export const runtime = "nodejs";

const Body = z.object({
  sub: z.string().min(1).max(200),
  groups: z.array(z.string()).max(200).default([]),
});

/**
 * DEV-ONLY local login. Mints a first-party session token from an arbitrary
 * subject + group set so the app is usable without a running Keycloak. This
 * route is hard-disabled unless DEV_AUTH_ENABLED is true (and it defaults to
 * false in production), so it cannot be used to bypass OIDC in a deployment.
 */
export async function POST(req: Request) {
  try {
    if (!config.devAuthEnabled || config.isProduction) {
      throw new HttpError(403, "dev login is disabled");
    }
    const { sub, groups } = await readJson(req, Body);
    const token = await signSessionToken(sub, groups);
    await setSessionCookie(token);
    return json({ ok: true, sub, groups });
  } catch (err) {
    return errorResponse(err);
  }
}
