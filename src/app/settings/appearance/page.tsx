import { settingsSection } from "@/lib/settings";
import { SectionPlaceholder, SettingsSectionPage } from "@/components/settings/section";

export default function Page() {
  return (
    <SettingsSectionPage section={settingsSection("appearance")}>
      <SectionPlaceholder />
    </SettingsSectionPage>
  );
}
