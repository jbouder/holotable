import "./lib/env";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  type CaseResult,
  EVALS_DIR,
  loadCases,
  loadRecording,
  loadSource,
  replayModel,
  runCase,
} from "./lib/eval";

/*
 * npm run eval -- [--replay | --live] [--record] [--case <name>]… [--json <file>]
 *
 *   --replay   (default) Grade every case's recorded answer. Free, deterministic,
 *              and run on every pull request: any failure exits 1.
 *   --live     Ask the configured provider (AI_PROVIDER/AI_MODEL, as the server
 *              would) and report a pass rate. Exits 0 whatever the rate: it
 *              measures, it does not gate. Spends tokens.
 *   --record   With --live, write each answer to evals/recordings/, replacing
 *              the old one, so replay grades it from then on.
 *   --case     Run only the named case(s).
 *   --json     Also write the results to this file.
 *
 * Adding a case is one file in evals/corpus/ and a recording:
 * `npm run eval -- --live --record --case <name>`.
 */

const { values } = parseArgs({
  options: {
    replay: { type: "boolean", default: false },
    live: { type: "boolean", default: false },
    record: { type: "boolean", default: false },
    case: { type: "string", multiple: true },
    json: { type: "string" },
  },
});

async function main(): Promise<number> {
  if (values.replay && values.live) throw new Error("choose one of --replay and --live");
  if (values.record && !values.live) throw new Error("--record needs --live");
  const live = values.live === true;

  const only = new Set(values.case ?? []);
  const cases = loadCases().filter((c) => only.size === 0 || only.has(c.name));
  if (only.size > 0 && cases.length !== only.size) {
    const known = new Set(cases.map((c) => c.name));
    throw new Error(`unknown case: ${[...only].filter((n) => !known.has(n)).join(", ")}`);
  }

  // Resolved only for a live run, so a replay never needs a model configured.
  // (The provider module itself is already loaded through the request path
  // the replay drives; what it must not need is `AI_MODEL`.)
  const model = live ? (await import("@/lib/ai/provider")).getModel() : null;

  const results: CaseResult[] = [];
  for (const c of cases) {
    const source = loadSource(c.catalog);
    let result: CaseResult;
    if (model) {
      try {
        result = await runCase(c, source, model);
      } catch (err) {
        result = {
          name: c.name,
          ok: false,
          failures: [
            `the model call failed: ${err instanceof Error ? err.message : err}`,
          ],
          text: "",
          completed: false,
          model: "",
          requestDigest: "",
        };
      }
      if (values.record && result.completed) record(result);
    } else {
      const recording = loadRecording(c.name);
      if (!recording) {
        result = {
          name: c.name,
          ok: false,
          failures: [
            `no recording; run \`npm run eval -- --live --record --case ${c.name}\``,
          ],
          text: "",
          completed: false,
          model: "",
          requestDigest: "",
        };
      } else {
        result = await runCase(c, source, replayModel(recording));
        result.model = recording.model;
        result.stale = recording.requestDigest !== result.requestDigest;
      }
    }
    results.push(result);
    report(result);
  }

  const passed = results.filter((r) => r.ok).length;
  const rate = results.length > 0 ? passed / results.length : 0;
  const stale = results.filter((r) => r.stale).length;
  console.log(
    `\n${live ? "live" : "replay"}: ${passed}/${results.length} passed (${(rate * 100).toFixed(0)}%)`,
  );
  if (stale > 0) {
    console.log(
      `${stale} recording(s) were made against an older prompt; they still grade, but re-record them with --live --record to measure the current one.`,
    );
  }
  if (values.json) {
    writeFileSync(
      values.json,
      `${JSON.stringify(
        { mode: live ? "live" : "replay", passed, total: results.length, rate, results },
        (key, value) => (key === "text" ? undefined : value),
        2,
      )}\n`,
    );
  }
  summarize(live, results, passed);

  // A replay failure is a regression in the prompt, the schema or the guard
  // against an answer that used to pass; a live failure is the model's.
  return live ? 0 : passed === results.length ? 0 : 1;
}

function report(r: CaseResult): void {
  const mark = r.ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${r.name}${r.stale ? "  (stale recording)" : ""}`);
  for (const f of r.failures) console.log(`        ${f}`);
}

function record(r: CaseResult): void {
  const dir = join(EVALS_DIR, "recordings");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${r.name}.json`),
    `${JSON.stringify(
      {
        model: r.model,
        recordedAt: new Date().toISOString(),
        requestDigest: r.requestDigest,
        text: r.text,
        ...(r.steps ? { steps: r.steps } : {}),
      },
      null,
      2,
    )}\n`,
  );
}

/** The GitHub Actions job summary, when there is one. */
function summarize(live: boolean, results: CaseResult[], passed: number): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const model = results.find((r) => r.model)?.model ?? "unknown";
  const rows = results.map(
    (r) =>
      `| ${r.ok ? "✅" : "❌"} | \`${r.name}\` | ${r.failures.join("<br>").replaceAll("|", "\\|") || "—"} |`,
  );
  appendFileSync(
    file,
    [
      `## LLM eval (${live ? "live" : "replay"}): ${passed}/${results.length} passed`,
      "",
      `Model: \`${model}\``,
      "",
      "| | Case | Failures |",
      "|---|---|---|",
      ...rows,
      "",
    ].join("\n"),
  );
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  },
);
