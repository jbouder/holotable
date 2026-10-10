import { settingsSection } from "@/lib/settings";
import { SettingsSectionPage } from "@/components/settings/section";
import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { getIdentity } from "@/lib/auth/authorize";
import { requestPreferences } from "@/lib/preferences-server";

export const dynamic = "force-dynamic";

export default async function Page() {
  // Patterns in charts is a synced preference (#77), unlike the theme and
  // motion beside it, so its saved value comes from the server.
  const identity = await getIdentity();
  const prefs = identity ? await requestPreferences(identity) : null;
  return (
    <SettingsSectionPage section={settingsSection("appearance")}>
      <AppearanceSettings chartPatterns={prefs?.chartPatterns ?? false} />
    </SettingsSectionPage>
  );
}
