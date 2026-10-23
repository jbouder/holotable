import { LogIn } from "lucide-react";
import { buttonClassName } from "@/components/ui/button-styles";
import { Card, CardContent } from "@/components/ui/card";
import { Logo } from "@/components/ui/logo";
import { type AuthMode, config, hasRealm } from "@/lib/config";
import { ResumeSession } from "@/components/resume-session";

/** The card's words in each mode. */
const COPY: Record<AuthMode, { title: string; action: string; note: string }> = {
  oidc: {
    title: "Sign in to Holotable",
    action: "Sign in",
    note: "Single sign-on through your organization's Keycloak.",
  },
  demo: {
    title: "Holotable demo",
    action: "Enter the demo",
    note: "No account needed. Everyone shares one demo workspace.",
  },
  local: {
    title: "Holotable",
    action: "Open Holotable",
    note: "No account needed. This server signs you in as its owner.",
  },
};

/**
 * Sign-in surface. Starts the Keycloak OIDC flow — the only way in, so the one
 * action here is a link to `/api/auth/login` and nothing else. In demo mode
 * (#251) the same link mints a demo session instead, and in local mode (#600)
 * the owner's. Few people see it:
 * `src/proxy.ts` sends a page request with no session cookie to that route
 * first, in every mode. What lands here is an expired or invalid cookie, and,
 * with a realm, someone who just signed out, whom the realm's own session
 * would otherwise sign straight back in. A Server Component on purpose: the
 * mode is read on the server, where `AUTH_MODE` exists. With a realm, it first
 * tries to renew a session that has only expired (#27).
 */
export function SignIn() {
  const mode = config.authMode;
  const copy = COPY[mode];
  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardContent className="space-y-7 p-6 sm:p-8">
          <div>
            <div className="flex items-center gap-3">
              <Logo className="text-primary" />
              <h1 className="text-xl font-semibold">{copy.title}</h1>
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
              <LogIn className="h-4 w-4" /> {copy.action}
            </a>
            {hasRealm(mode) && <ResumeSession />}
            <p className="text-center text-xs text-muted">{copy.note}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
