import { settingsSection } from "@/lib/settings";
import { SettingsSectionPage } from "@/components/settings/section";
import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { getIdentity } from "@/lib/auth/authorize";
import { operatorTheme } from "@/lib/operator-theme";
import { requestPreferences } from "@/lib/preferences-server";
import { paletteInfo } from "@/lib/theme";

export const dynamic = "force-dynamic";

export default async function Page() {
  // Patterns in charts is a synced preference (#77), unlike the theme and
  // motion beside it, so its saved value comes from the server.
  const identity = await getIdentity();
  const prefs = identity ? await requestPreferences(identity) : null;
  // The themes on offer, the operator's (#508) among them, from the server:
  // a client component's own server render cannot see THEME_FILE, and the
  // gallery has to render the same cards on both sides.
  operatorTheme();
  return (
    <SettingsSectionPage section={settingsSection("appearance")}>
      <AppearanceSettings
        chartPatterns={prefs?.chartPatterns ?? false}
        palettes={[...paletteInfo()]}
      />
    </SettingsSectionPage>
  );
}
