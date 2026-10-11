import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The version being released lives in two files, and the chart's default
 * image tag is its `appVersion`: if they drift, a release tag installs an
 * image that was never published. `.github/workflows/release.yml` refuses a
 * tag that disagrees with them; this keeps them agreeing with each other.
 */
test("package.json and the chart's appVersion name the same version", () => {
  const root = new URL("../", import.meta.url);
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
    version: string;
  };
  const chart = readFileSync(new URL("deploy/helm/holotable/Chart.yaml", root), "utf8");
  const appVersion = /^appVersion:\s*"?([^"\n]+)"?\s*$/m.exec(chart)?.[1];
  assert.equal(appVersion, pkg.version);
  assert.match(pkg.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
});
