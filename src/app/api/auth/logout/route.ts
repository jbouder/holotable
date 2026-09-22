import { clearSessionCookie } from "@/lib/auth/cookie";
import { route } from "@/lib/http";

export const runtime = "nodejs";

export const POST = route("auth.logout", async () => {
  await clearSessionCookie();
  return Response.json({ ok: true });
});
