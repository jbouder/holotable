import { defineConfig, devices } from "@playwright/test";
import {
  APP_ENV,
  APP_PORT,
  BASE_URL,
  MODEL_ENDPOINT_URL,
  ROOT,
  SEED_ENV,
  storageStatePath,
} from "./env";

/**
 * The end-to-end suite (#88) and the accessibility scans that ride on it (#91).
 *
 *   npm run e2e                 prepare the stack, build, start, run everything
 *   E2E_SKIP_BUILD=1 npm run e2e   reuse the last `next build`
 *
 * Playwright starts three processes and stops them when the run ends: the
 * stub model endpoint, the looping seeder, so live panels have rows arriving
 * while a test watches, and the production build of the app. Signing in
 * happens once per role in the `setup` project, through the real Keycloak
 * login form; every other spec starts from the saved session.
 *
 * Two projects run the specs (#610), against that one app and one database:
 *
 * - `parallel`, every test not tagged `@serial`, spread over the workers. A
 *   test here reads seeded state or creates records of its own under a name
 *   no other test uses (`unique()` in e2e/support/app.ts), and never counts
 *   a shared list.
 * - `serial`, the tests tagged `@serial`, one at a time once `parallel` is
 *   done: they share mutable state through the one workspace (uploads under
 *   the per-person upload budget, the DuckDB root and the files demo, a
 *   workspace's default model, the person's "keep conversations"), and each
 *   says why at its top. Because it depends on `parallel`, a failure there
 *   skips it: fix that one first.
 */

const skipBuild = process.env.E2E_SKIP_BUILD === "1";

export default defineConfig({
  testDir: ".",
  outputDir: "test-results",
  // Four on GitHub's Linux runners, which have four cores; locally half the
  // machine's cores, Playwright's default. `npm run e2e -- --workers=N`
  // overrides either; the serial project stays at one.
  workers: process.env.CI ? 4 : undefined,
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
      name: "parallel",
      testMatch: /\.spec\.ts$/,
      grepInvert: /@serial/,
      fullyParallel: true,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: storageStatePath("admin") },
    },
    {
      name: "serial",
      testMatch: /\.spec\.ts$/,
      grep: /@serial/,
      fullyParallel: false,
      workers: 1,
      // After the parallel project, so these do not share the stack under load.
      dependencies: ["parallel"],
      use: { ...devices["Desktop Chrome"], storageState: storageStatePath("admin") },
    },
  ],
  webServer: [
    {
      // Before the app, so its boot scan finds the model (#607).
      command: "npx tsx e2e/model-endpoint.ts",
      cwd: ROOT,
      url: `${MODEL_ENDPOINT_URL}/models`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
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
