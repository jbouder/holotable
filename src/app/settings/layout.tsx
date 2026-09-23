import type * as React from "react";
import { getIdentity } from "@/lib/auth/authorize";
import { visibleSections } from "@/lib/settings";
import { SignIn } from "@/components/sign-in";
import { SettingsNav } from "@/components/settings/settings-nav";

export const dynamic = "force-dynamic";

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const identity = await getIdentity();
  if (!identity) return <SignIn />;

  // Only what the nav draws crosses to the client: a predicate cannot, and
  // the client has no use for one.
  const sections = visibleSections(identity).map(({ id, label, href }) => ({
    id,
    label,
    href,
  }));

  return (
    <div className="mx-auto w-full max-w-5xl">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <div className="mt-6 flex flex-col gap-6 md:flex-row md:gap-10">
        <SettingsNav sections={sections} />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
