import { LayoutDashboard, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Sign-in surface. Starts the Keycloak OIDC flow — the only way in, so the one
 * action here is a link to `/api/auth/login` and nothing else.
 */
export function SignIn() {
  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardContent className="space-y-6 p-6 sm:p-8">
          <div>
            <div className="flex items-center gap-3">
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center border border-primary/40 bg-primary/10 text-primary"
                aria-hidden="true"
              >
                <LayoutDashboard className="h-5 w-5" />
              </span>
              <h1 className="text-xl font-semibold">Sign in to Holotable</h1>
            </div>
            <p className="mt-3 text-sm text-muted">
              Natural-language dashboards for your monitoring data.
            </p>
          </div>

          <div className="space-y-2">
            <a href="/api/auth/login" className="block">
              <Button className="w-full">
                <LogIn className="h-4 w-4" /> Sign in
              </Button>
            </a>
            <p className="text-center text-xs text-muted">
              Single sign-on through your organization&apos;s Keycloak.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
