import { expect, type APIRequestContext, type Page } from "@playwright/test";

/** Helpers shared by the specs. Nothing here signs in; the setup project did. */

/** A seeded dashboard's id, by title (scripts/seed.ts). */
export async function dashboardId(request: APIRequestContext, title: string) {
  const res = await request.get(`/api/dashboards?search=${encodeURIComponent(title)}`);
  expect(res.ok(), `GET /api/dashboards answered ${res.status()}`).toBe(true);
  const body = (await res.json()) as { dashboards: { id: string; title: string }[] };
  const found = body.dashboards.find((d) => d.title === title);
  if (!found) throw new Error(`no dashboard titled "${title}"; did the seeder run?`);
  return found.id;
}

/** The seeded dashboard every read-only spec opens. */
export const DEMO_DASHBOARD = "Demo service health";

/**
 * Wait for a live dashboard to have drawn: every panel's loading skeleton gone.
 * The stream never goes idle, so "network idle" is not a signal here.
 */
export async function waitForPanels(page: Page) {
  await expect(page.locator("[data-panel-id]").first()).toBeVisible();
  await expect(page.locator('[data-panel-id][data-status="loading"]')).toHaveCount(0);
}
