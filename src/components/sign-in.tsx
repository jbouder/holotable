import { LayoutDashboard, LogIn } from "lucide-react";
import { buttonClassName } from "@/components/ui/button-styles";
import { Card, CardContent } from "@/components/ui/card";
import { config } from "@/lib/config";
import { ResumeSession } from "@/components/resume-session";

/**
 * Sign-in surface. Starts the Keycloak OIDC flow — the only way in, so the one
 * action here is a link to `/api/auth/login` and nothing else. In demo mode
 * (#251) the same link mints a demo session instead; a visitor normally never
 * sees this, because `src/proxy.ts` sends a cookie-less page request there
 * first, but an expired or invalid cookie still lands here. A Server Component
 * on purpose: the mode is read on the server, where `AUTH_MODE` exists. With
 * a realm, it first tries to renew a session that has only expired (#27).
 */
export function SignIn() {
  const demo = config.authMode === "demo";
  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardContent className="space-y-7 p-6 sm:p-8">
          <div>
            <div className="flex items-center gap-3">
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center border border-primary/40 bg-primary/10 text-primary"
                aria-hidden="true"
              >
                <LayoutDashboard className="h-5 w-5" />
              </span>
              <h1 className="text-xl font-semibold">
                {demo ? "Holotable demo" : "Sign in to Holotable"}
              </h1>
            </div>
            <p className="mt-3 text-sm text-muted">
              Natural-language dashboards for your monitoring data.
            </p>
          </div>

          <div className="space-y-4">
            {/*
              A plain link, not `next/link`: this starts the OIDC redirect and
              must be a full navigation, never a client-side one or a
              prefetch. Styled as a button, not wrapping one (#77).
            */}
            <a
              href="/api/auth/login"
              className={buttonClassName({ className: "w-full" })}
            >
              <LogIn className="h-4 w-4" /> {demo ? "Enter the demo" : "Sign in"}
            </a>
            {!demo && <ResumeSession />}
            <p className="text-center text-xs text-muted">
              {demo
                ? "No account needed. Everyone shares one demo workspace."
                : "Single sign-on through your organization's Keycloak."}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
