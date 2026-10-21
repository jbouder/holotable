import { expect, type Page, test } from "@playwright/test";
import { USERS } from "./env";

/*
 * Signing in without the sign-in card: a page opened with no session goes
 * straight to the realm and comes back to that page, and signing out stays
 * signed out although the realm's own session is still alive.
 */

test.use({ storageState: { cookies: [], origins: [] } });

async function realmSignIn(page: Page) {
  const { username, password } = USERS.viewer;
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
}

test("a link opened without a session signs in at the realm and lands on it", async ({
  page,
}) => {
  await page.goto("/?sort=name");
  // The realm's login form, not the app's sign-in card.
  await expect(page.locator("#kc-login")).toBeVisible();
  await realmSignIn(page);
  await expect(page).toHaveURL(/\/\?sort=name$/);
  await expect(page.getByRole("button", { name: /account/i })).toBeVisible();
});

test("signing out stays signed out, and Sign in goes back through the realm", async ({
  page,
}) => {
  await page.goto("/");
  await realmSignIn(page);
  await page.getByRole("button", { name: /account/i }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();

  // The realm still has a session, but the app does not go back to it.
  await expect(
    page.getByRole("heading", { level: 1, name: "Sign in to Holotable" }),
  ).toBeVisible();
  await page.goto("/explore");
  await expect(
    page.getByRole("heading", { level: 1, name: "Sign in to Holotable" }),
  ).toBeVisible();

  // Sign in is one click: the realm's session answers without a form.
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: /account/i })).toBeVisible();
  // And a page without a session goes to the realm again afterwards.
  await page.context().clearCookies({ name: "holotable_session" });
  await page.goto("/explore");
  await expect(page).toHaveURL(/\/explore$/);
  await expect(page.getByRole("button", { name: /account/i })).toBeVisible();
});
