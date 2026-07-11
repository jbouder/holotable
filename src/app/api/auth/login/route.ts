import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { buildAuthorizeUrl } from "@/lib/auth/oidc";
import { errorResponse } from "@/lib/auth/authorize";
import { config } from "@/lib/config";

export const runtime = "nodejs";

/** Begin the Keycloak OIDC login flow. */
export async function GET(req: Request) {
  try {
    const origin = new URL(req.url).origin;
    const state = randomBytes(16).toString("hex");
    const nonce = randomBytes(16).toString("hex");

    const store = await cookies();
    const opts = {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: "lax" as const,
      path: "/",
      maxAge: 600,
    };
    store.set("holotable_oidc_state", state, opts);
    store.set("holotable_oidc_nonce", nonce, opts);

    const url = await buildAuthorizeUrl(origin, state, nonce);
    return Response.redirect(url, 302);
  } catch (err) {
    return errorResponse(err);
  }
}
