import { settingsSection } from "@/lib/settings";
import { SHORTCUT_SECTIONS } from "@/lib/shortcuts";
import { SettingsSectionPage } from "@/components/settings/section";
import { ShortcutList } from "@/components/shortcut-list";
import { Card, CardContent } from "@/components/ui/card";

/** Every shortcut the app binds, by where it works (#217). */
export default function Page() {
  return (
    <SettingsSectionPage section={settingsSection("shortcuts")}>
      {SHORTCUT_SECTIONS.map((section) => (
        <section key={section.id} aria-labelledby={`shortcuts-${section.id}`}>
          <h3 id={`shortcuts-${section.id}`} className="text-sm font-semibold">
            {section.title}
          </h3>
          <p className="mt-1 text-sm text-muted">{section.description}</p>
          <Card className="mt-3">
            <CardContent className="py-4">
              <ShortcutList shortcuts={section.shortcuts} headingLevel="h4" />
            </CardContent>
          </Card>
        </section>
      ))}
      <p className="text-xs text-muted">
        Every shortcut has a button or menu item too. Nothing is reachable by keyboard
        only.
      </p>
    </SettingsSectionPage>
  );
}
