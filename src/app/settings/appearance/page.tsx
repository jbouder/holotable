import { settingsSection } from "@/lib/settings";
import { SettingsSectionPage } from "@/components/settings/section";
import { AppearanceSettings } from "@/components/settings/appearance-settings";

export default function Page() {
  return (
    <SettingsSectionPage section={settingsSection("appearance")}>
      <AppearanceSettings />
    </SettingsSectionPage>
  );
}
