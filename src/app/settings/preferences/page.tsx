import { getIdentity } from "@/lib/auth/authorize";
import { accessibleWorkspaces } from "@/lib/auth/claims";
import { listDashboards } from "@/lib/db/repo";
import { log } from "@/lib/log";
import { requestPreferences } from "@/lib/preferences-server";
import { settingsSection } from "@/lib/settings";
import { SignIn } from "@/components/sign-in";
import { SettingsSectionPage } from "@/components/settings/section";
import {
  PreferencesForm,
  type StartDashboardOption,
} from "@/components/settings/preferences-form";

export const dynamic = "force-dynamic";

/** The most dashboards the start-page picker lists from one workspace. */
const PICKER_LIMIT = 200;

/**
 * Where you start and how times are shown (#214, #215). Saved to the account,
 * so both follow the person to any device they sign in on.
 */
export default async function PreferencesSettings() {
  const identity = await getIdentity();
  if (!identity) return <SignIn />;
  const prefs = await requestPreferences(identity);

  // Only dashboards the caller can view: the workspaces come from the claims,
  // and the save re-checks the choice with `can()` either way.
  let dashboards: StartDashboardOption[] = [];
  try {
    const pages = await Promise.all(
      accessibleWorkspaces(identity).map((w) =>
        listDashboards(w, { sort: "title", limit: PICKER_LIMIT, userSub: identity.sub }),
      ),
    );
    dashboards = pages
      .flatMap((p) => p.dashboards)
      .map((d) => ({ id: d.id, title: d.title, workspaceId: d.workspaceId }));
  } catch (err) {
    log.warn("preferences.picker_failed", { err });
  }

  return (
    <SettingsSectionPage section={settingsSection("preferences")}>
      <PreferencesForm initial={prefs} dashboards={dashboards} />
    </SettingsSectionPage>
  );
}
