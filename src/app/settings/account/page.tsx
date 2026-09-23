import { ExternalLink, ShieldCheck, Users } from "lucide-react";
import { getIdentity } from "@/lib/auth/authorize";
import { accountSummary, ROLE_LABELS, roleCapabilities, roleGuide } from "@/lib/account";
import { config } from "@/lib/config";
import { settingsSection } from "@/lib/settings";
import { SignIn } from "@/components/sign-in";
import { SettingsSectionPage } from "@/components/settings/section";
import { CopyButton } from "@/components/settings/copy-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

/**
 * Who you are signed in as and what you can reach (#211). Everything on it is
 * the session's own identity, the same object `GET /api/me` answers with; the
 * role descriptions are asked of `can()` rather than written out, so they
 * cannot drift from the rule.
 */
export default async function AccountSettings() {
  const identity = await getIdentity();
  if (!identity) return <SignIn />;
  const account = accountSummary(identity);
  const accountUrl = config.oidcAccountUrl;

  return (
    <SettingsSectionPage section={settingsSection("account")}>
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          {account.platformAdmin && (
            <Badge className="gap-1">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Platform admin
            </Badge>
          )}
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted">Name</dt>
            <dd>
              {account.displayName ?? <span className="text-muted">Not provided</span>}
            </dd>
            <dt className="text-muted">Email</dt>
            <dd className="break-all">
              {account.email ?? <span className="text-muted">Not provided</span>}
            </dd>
            <dt className="text-muted">User id</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <code className="break-all font-mono text-xs">{account.sub}</code>
              <CopyButton value={account.sub} label="Copy user id" />
            </dd>
          </dl>
          <p className="mt-4 text-xs text-muted">
            Your name, email and password belong to your identity provider.
            {accountUrl
              ? " Change them there."
              : " Ask your administrator to change them."}
          </p>
          {accountUrl && (
            <a
              href={accountUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="tap-target mt-2 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              Manage your account <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          )}
        </CardContent>
      </Card>

      <div>
        <h3 className="text-sm font-semibold">Workspaces</h3>
        <p className="mt-1 text-sm text-muted">
          Roles come from your groups in the identity provider. A change there takes
          effect the next time you sign in.
          {account.platformAdmin &&
            " As a platform admin you can also reach every workspace, including ones not listed here."}
        </p>
        <div className="mt-3">
          {account.workspaces.length === 0 ? (
            <EmptyState
              icon={<Users className="h-6 w-6" />}
              title="No workspaces yet"
              description="You are signed in, but none of your groups grants a role in a workspace. Ask an administrator to add you to one."
            />
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeader>Workspace</TableHeader>
                  <TableHeader>Role</TableHeader>
                  <TableHeader>You can</TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {account.workspaces.map(({ id, role }) => (
                  <TableRow key={id}>
                    <TableCell className="font-mono text-xs">{id}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {ROLE_LABELS[role]}
                    </TableCell>
                    <TableCell className="text-muted">
                      {roleCapabilities(role).join(" · ")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>

      <details className="border border-border bg-surface px-4 py-3 text-sm">
        <summary className="cursor-pointer font-medium">What each role allows</summary>
        <dl className="mt-3 space-y-3">
          {roleGuide().map(({ role, label, allows }) => (
            <div key={role}>
              <dt className="font-medium">{label}</dt>
              <dd className="text-muted">{allows.join(" · ")}</dd>
            </div>
          ))}
        </dl>
      </details>
    </SettingsSectionPage>
  );
}
