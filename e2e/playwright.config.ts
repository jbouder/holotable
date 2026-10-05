import { defineConfig, devices } from "@playwright/test";
import { APP_ENV, APP_PORT, BASE_URL, ROOT, SEED_ENV, storageStatePath } from "./env";

/**
 * The end-to-end suite (#88) and the accessibility scans that ride on it (#91).
 *
 *   npm run e2e                 prepare the stack, build, start, run everything
 *   E2E_SKIP_BUILD=1 npm run e2e   reuse the last `next build`
 *
 * Playwright starts two processes and stops both when the run ends: the
 * looping seeder, so live panels have rows arriving while a test watches, and
 * the production build of the app. Signing in happens once per role in the
 * `setup` project, through the real Keycloak login form; every other spec
 * starts from the saved session.
 */

const skipBuild = process.env.E2E_SKIP_BUILD === "1";

export default defineConfig({
  testDir: ".",
  outputDir: "test-results",
  // The journey is one story told in order, and the stack is one database.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : [["list"]],
  use: {
    baseURL: BASE_URL,
    // A control that is not there in 15s is not coming; fail on the step.
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    // Kept only when something failed, and uploaded by CI as an artifact.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts$/ },
    {
      name: "chromium",
      testMatch: /\.spec\.ts$/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: storageStatePath("admin") },
    },
  ],
  webServer: [
    {
      command: "npx tsx scripts/seed.ts",
      cwd: ROOT,
      env: SEED_ENV,
      wait: { stdout: /seeding metrics every/ },
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
    },
    {
      command: skipBuild
        ? `npx next start -p ${APP_PORT}`
        : `npx next build && npx next start -p ${APP_PORT}`,
      cwd: ROOT,
      env: APP_ENV,
      url: `${BASE_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 600_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
    },
  ],
});
