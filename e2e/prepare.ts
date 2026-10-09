import { execFileSync } from "node:child_process";
import { APP_PORT, DATABASE_URL, KC_PORT, PG_PORT, PROM_PORT, SCRAPE_TOKEN } from "./env";

/**
 * Bring the dependencies up and the schema current, before Playwright starts
 * the seeder and the app (#88). `npm run e2e` runs this first; it is a script
 * rather than Playwright's `globalSetup` because Playwright starts its
 * `webServer`s before `globalSetup`, and both of them need the database.
 *
 * `docker compose up --wait` is idempotent, so a second run against a stack
 * that is already up costs a second. `E2E_SKIP_COMPOSE=1` skips it for a job
 * that started the stack in an earlier step, or for services of your own.
 */
const env = {
  ...process.env,
  E2E_PG_PORT: String(PG_PORT),
  E2E_KC_PORT: String(KC_PORT),
  E2E_PROM_PORT: String(PROM_PORT),
  E2E_PORT: String(APP_PORT),
  E2E_SCRAPE_TOKEN: SCRAPE_TOKEN,
};

if (process.env.E2E_SKIP_COMPOSE !== "1") {
  execFileSync("docker", ["compose", "-f", "e2e/compose.yml", "up", "-d", "--wait"], {
    stdio: "inherit",
    env,
  });
}

execFileSync("npx", ["tsx", "scripts/migrate.ts"], {
  stdio: "inherit",
  env: { ...env, DATABASE_URL },
});
