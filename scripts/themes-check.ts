import { readFileSync } from "node:fs";
import { parseThemeBlocks } from "@/lib/color/contrast";
import { type QualityTier, qualityReport } from "@/lib/color/quality";

/**
 * Every theme in globals.css against the quality rules (#504), as a table for
 * whoever is tuning tokens: `npm run themes:check`, or `-- --operator` for the
 * operator tier. Exits non-zero when a rule fails, like the test that holds it.
 */
const tier: QualityTier = process.argv.includes("--operator") ? "operator" : "builtin";
const css = readFileSync("src/app/globals.css", "utf8");
let failed = 0;
for (const block of parseThemeBlocks(css)) {
  const report = qualityReport(block.tokens, tier);
  process.stdout.write(`\n${block.palette} ${block.scheme} (${tier})\n`);
  for (const m of report) {
    if (!m.ok) failed++;
    process.stdout.write(
      `  ${m.ok ? "ok  " : "FAIL"}  ${m.rule.padEnd(16)} ${m.where.padEnd(52)} ${m.measured.toFixed(3).padStart(7)}  >= ${m.floor}\n`,
    );
  }
}
process.stdout.write(`\n${failed === 0 ? "every rule passes" : `${failed} failing`}\n`);
process.exit(failed === 0 ? 0 : 1);
