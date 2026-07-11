"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Sign-in surface. Offers the Keycloak OIDC flow, and (only when the server has
 * enabled dev auth) a local dev login for running without Keycloak.
 */
export function SignIn({ devAuthEnabled }: { devAuthEnabled: boolean }) {
  const router = useRouter();
  const [sub, setSub] = React.useState("dev-user");
  const [groups, setGroups] = React.useState(
    "/workspaces/demo/source-admin",
  );
  const [error, setError] = React.useState<string | null>(null);

  async function devLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/auth/dev-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sub,
        groups: groups.split(/[\n,]+/).map((g) => g.trim()).filter(Boolean),
      }),
    });
    if (!res.ok) {
      setError((await res.json()).error ?? "login failed");
      return;
    }
    router.push("/dashboards");
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-md">
      <h1 className="mb-4 text-xl font-semibold">Sign in to Holotable</h1>
      <Card>
        <CardContent className="space-y-4">
          <a href="/api/auth/login">
            <Button className="w-full">Sign in with Keycloak</Button>
          </a>

          {devAuthEnabled && (
            <form onSubmit={devLogin} className="space-y-3 border-t border-border pt-4">
              <p className="text-xs text-muted">
                Development login (disabled in production).
              </p>
              <div>
                <Label htmlFor="sub">Subject</Label>
                <Input id="sub" value={sub} onChange={(e) => setSub(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="groups">Groups (comma/newline separated)</Label>
                <Input
                  id="groups"
                  value={groups}
                  onChange={(e) => setGroups(e.target.value)}
                />
              </div>
              {error && <p className="text-sm text-danger">{error}</p>}
              <Button type="submit" variant="secondary" className="w-full">
                Dev sign in
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
