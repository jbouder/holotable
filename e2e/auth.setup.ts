import { expect, test as setup } from "@playwright/test";
import { type Role, storageStatePath, USERS } from "./env";

/*
 * Sign in once per role, through the real realm (#88). There is no
 * development login path and there must not be one (AGENTS.md, "Auth"): the
 * suite drives the same authorization-code flow a person does, against the
 * dev realm, and saves the resulting first-party session for the specs.
 */

for (const role of Object.keys(USERS) as Role[]) {
  setup(`sign in as ${role}`, async ({ page }) => {
    const { username, password } = USERS[role];
    await page.goto("/api/auth/login");
    // Keycloak's own login form.
    await page.locator("#username").fill(username);
    await page.locator("#password").fill(password);
    await page.locator("#kc-login").click();
    // Back on the app with a session: the account menu replaces sign-in.
    await expect(page.getByRole("button", { name: /account/i })).toBeVisible();
    await page.context().storageState({ path: storageStatePath(role) });
  });
}
