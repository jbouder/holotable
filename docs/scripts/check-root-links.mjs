/**
 * Check the links in the repository's root markdown files (#144).
 *
 * `starlight-links-validator` covers the docs site. The files a reader meets
 * first on GitHub — the README, CONTRIBUTING, SECURITY, AGENTS, the pull
 * request template and the chart README — are outside the site, so nothing
 * checked them. This script does, offline:
 *
 * - a relative link must name a file or directory in the repository, and a
 *   `#fragment` on a markdown file must name one of its headings;
 * - a link to the hosted docs site must name a page in
 *   `docs/src/content/docs/` (including the generated reference pages, so run
 *   `npm run generate` first; `npm run build` does), and its fragment a heading
 *   on that page;
 * - a `github.com/jbouder/holotable/{blob,tree}/main/…` link must name a path
 *   in this checkout;
 * - a backticked repository path (`src/…`, `docs/…`, `test/…`, …) must exist.
 *
 * Any other URL is left alone: a network check would fail on someone else's
 * outage, not on this repository.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const docsRoot = join(repoRoot, "docs", "src", "content", "docs");
const DOCS_SITE = "https://holotable-docs.beskar.workers.dev";
const REPO_URL = /^https:\/\/github\.com\/jbouder\/holotable\/(?:blob|tree)\/main\/([^#?]*)(#.*)?$/;

const FILES = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "AGENTS.md",
  ".github/pull_request_template.md",
  "deploy/helm/holotable/README.md",
];

/** GitHub's and Starlight's heading slug, close enough for the headings used here. */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~[\]()]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

function anchors(path) {
  const text = readFileSync(path, "utf8");
  const found = new Set();
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const m = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (m) found.add(slug(m[1]));
  }
  return found;
}

/** `/operations/keycloak/` → the page that renders it, or null. */
function docsPage(sitePath) {
  const clean = sitePath.replace(/^\/+|\/+$/g, "");
  if (clean === "") return join(docsRoot, "index.mdx");
  for (const candidate of [`${clean}.md`, `${clean}.mdx`, `${clean}/index.md`, `${clean}/index.mdx`]) {
    const path = join(docsRoot, candidate);
    if (existsSync(path)) return path;
  }
  return null;
}

function checkFragment(file, fragment, problems, where) {
  if (!fragment || !/\.mdx?$/.test(file)) return;
  const id = decodeURIComponent(fragment.slice(1));
  if (!anchors(file).has(id)) problems.push(`${where}: no heading "#${id}" in ${relative(repoRoot, file)}`);
}

const problems = [];

for (const file of FILES) {
  const path = join(repoRoot, file);
  if (!existsSync(path)) {
    problems.push(`${file}: listed in check-root-links.mjs but missing`);
    continue;
  }
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  let inFence = false;

  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const where = `${file}:${index + 1}`;

    const targets = [
      ...[...line.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]),
      ...[...line.matchAll(/<(https?:\/\/[^>\s]+)>/g)].map((m) => m[1]),
    ];

    for (const target of targets) {
      if (target.startsWith(DOCS_SITE)) {
        const url = new URL(target);
        const page = docsPage(url.pathname);
        if (!page) problems.push(`${where}: ${target} is not a docs page`);
        else checkFragment(page, url.hash, problems, where);
        continue;
      }
      const repoLink = target.match(REPO_URL);
      if (repoLink) {
        if (!existsSync(join(repoRoot, repoLink[1]))) {
          problems.push(`${where}: ${target} names a path this checkout does not have`);
        }
        continue;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // other URLs, mailto:
      const [rel, hash] = target.split("#");
      const resolved = rel === "" ? path : join(dirname(path), rel);
      if (!existsSync(resolved)) {
        problems.push(`${where}: ${target} does not exist`);
        continue;
      }
      if (hash !== undefined && statSync(resolved).isFile()) {
        checkFragment(resolved, `#${hash}`, problems, where);
      }
    }

    for (const m of line.matchAll(/`((?:src|docs|test|scripts|deploy|migrations|timescaledb|keycloak|\.github)\/[^`\s]*)`/g)) {
      const ref = m[1].replace(/:\d+$/, "").replace(/[.,;:]+$/, "");
      if (/[*<>{}…]|\.\.\./.test(ref)) continue; // a pattern, not a path
      if (!existsSync(join(repoRoot, ref))) problems.push(`${where}: \`${ref}\` does not exist`);
    }
  });
}

if (problems.length > 0) {
  console.error(`\n  check-root-links: ${problems.length} broken reference(s)\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error("");
  process.exit(1);
}
console.log(`check-root-links: ${FILES.length} files, no broken links`);
