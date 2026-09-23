import "./lib/env";
import { runStartupChecks } from "@/lib/startup";

/**
 * `npm run config:check`: validate the configuration the way the server does
 * at startup, without starting it. Exits 1 when the configuration would
 * refuse to boot.
 *
 * Reads the same `.env*` files as Next, in the same order; set
 * `NODE_ENV=production` to apply production requirements the way a deployed
 * server will. The registered sources' `secret_ref`s are checked when the
 * database is reachable and skipped with a warning when it is not, so the
 * check also works in CI with no database.
 */
async function main(): Promise<number> {
  const production = process.env.NODE_ENV === "production";

  const result = await runStartupChecks({ production });
  if (result.report) {
    (result.ok ? console.warn : console.error)(result.report);
  } else {
    console.log(
      `Configuration is valid (${production ? "production" : "development"} rules).`,
    );
  }
  return result.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
