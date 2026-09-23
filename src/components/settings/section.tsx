import type * as React from "react";
import { Construction } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import type { SettingsSection } from "@/lib/settings";

/** A section's heading and one-line description, then its content. */
export function SettingsSectionPage({
  section,
  children,
}: {
  section: Pick<SettingsSection, "label" | "description">;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby="settings-section-title">
      <h2 id="settings-section-title" className="text-lg font-semibold">
        {section.label}
      </h2>
      <p className="mt-1 text-sm text-muted">{section.description}</p>
      <div className="mt-6 flex flex-col gap-6">{children}</div>
    </section>
  );
}

/** Stands in for a section whose controls have not landed yet. */
export function SectionPlaceholder() {
  return (
    <EmptyState
      icon={<Construction className="h-6 w-6" />}
      title="Not available yet"
      description="This section is on its way. Nothing here changes how Holotable behaves today."
    />
  );
}
