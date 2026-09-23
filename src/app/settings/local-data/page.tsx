import { cookies } from "next/headers";
import { getIdentity } from "@/lib/auth/authorize";
import { isDismissed, SETUP_DISMISSED_COOKIE } from "@/lib/dismissals";
import { settingsSection } from "@/lib/settings";
import { SignIn } from "@/components/sign-in";
import { SettingsSectionPage } from "@/components/settings/section";
import { LocalDataManager } from "@/components/settings/local-data-manager";

export const dynamic = "force-dynamic";

export default async function LocalDataSettings() {
  const identity = await getIdentity();
  if (!identity) return <SignIn />;
  // Read on the server, where the httpOnly cookie is visible, so the button's
  // state is right on first paint.
  const jar = await cookies();
  return (
    <SettingsSectionPage section={settingsSection("local-data")}>
      <LocalDataManager
        userSub={identity.sub}
        setupDismissed={isDismissed(jar.get(SETUP_DISMISSED_COOKIE)?.value)}
      />
    </SettingsSectionPage>
  );
}
