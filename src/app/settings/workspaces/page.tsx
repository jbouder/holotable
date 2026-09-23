import { notFound } from "next/navigation";
import { getIdentity } from "@/lib/auth/authorize";
import { sectionVisible, settingsSection } from "@/lib/settings";
import { SignIn } from "@/components/sign-in";
import { SectionPlaceholder, SettingsSectionPage } from "@/components/settings/section";

export const dynamic = "force-dynamic";

export default async function Page() {
  const identity = await getIdentity();
  if (!identity) return <SignIn />;
  const section = settingsSection("workspaces");
  if (!sectionVisible(section, identity)) notFound();
  return (
    <SettingsSectionPage section={section}>
      <SectionPlaceholder />
    </SettingsSectionPage>
  );
}
