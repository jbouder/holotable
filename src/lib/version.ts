import pkg from "../../package.json";

/**
 * Build identity, reported by `/api/health` so an operator looking at a
 * running container can tell which build answered.
 *
 * `package.json` is the source of truth for the version; `APP_VERSION` exists
 * for deployments that stamp their own (a chart appVersion, a release tag).
 * The commit has no in-repo source — a built image has no `.git` — so it comes
 * from `GIT_COMMIT`, set as a build argument in the Dockerfile, and reads
 * `"unknown"` when nobody set it. Neither value is a secret: both name a
 * public artifact of the build.
 *
 * Not in `src/lib/config.ts` on purpose: that module reaches the browser
 * bundle through the poller, and importing `package.json` there would inline
 * the whole dependency list into it.
 */

/** Short commit hashes are 7 chars; a full hash is 40. Keep the display short. */
const COMMIT_DISPLAY_LENGTH = 12;

export const appVersion: string = process.env.APP_VERSION || pkg.version;

export const appCommit: string = (process.env.GIT_COMMIT || "unknown").slice(
  0,
  COMMIT_DISPLAY_LENGTH,
);
