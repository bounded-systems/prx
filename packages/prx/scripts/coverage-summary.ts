#!/usr/bin/env bun
/**
 * Summarize an lcov coverage report into a Markdown table.
 *
 * `bun test --coverage --coverage-reporter=lcov` writes `coverage/lcov.info`.
 * This parses it and emits overall line / function / branch coverage. When
 * `GITHUB_STEP_SUMMARY` is set (in CI), the table is appended there so it shows
 * up on the workflow run page. No external service, no third-party action.
 *
 * Report-only: a missing or empty report prints a note and exits 0 — coverage
 * never gates CI.
 *
 * Usage:
 *   bun run scripts/coverage-summary.ts [coverage/lcov.info]
 */

import { readFileSync } from "node:fs";
import { appendFileSync } from "node:fs";

const lcovPath = process.argv[2] ?? "coverage/lcov.info";

type Totals = { lf: number; lh: number; fnf: number; fnh: number; brf: number; brh: number; files: number };

function parse(lcov: string): Totals {
  const t: Totals = { lf: 0, lh: 0, fnf: 0, fnh: 0, brf: 0, brh: 0, files: 0 };
  for (const line of lcov.split("\n")) {
    const [tag, rawValue] = line.split(":", 2);
    const n = Number(rawValue);
    switch (tag) {
      case "SF": t.files += 1; break;
      case "LF": t.lf += n; break;
      case "LH": t.lh += n; break;
      case "FNF": t.fnf += n; break;
      case "FNH": t.fnh += n; break;
      case "BRF": t.brf += n; break;
      case "BRH": t.brh += n; break;
    }
  }
  return t;
}

function pct(hit: number, found: number): string {
  if (found === 0) return "n/a";
  return `${((hit / found) * 100).toFixed(2)}%`;
}

function emit(text: string): void {
  process.stdout.write(text + "\n");
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    try {
      appendFileSync(summary, text + "\n");
    } catch (error) {
      process.stderr.write(`Warning: failed to append coverage summary to \`${summary}\`: ${String(error)}\n`);
    }
  }
}

function main(): void {
  let lcov: string;
  try {
    lcov = readFileSync(lcovPath, "utf8");
  } catch {
    emit(`### Coverage\n\nNo coverage report found at \`${lcovPath}\` — skipping.`);
    return;
  }

  const t = parse(lcov);
  emit(
    [
      "### Coverage",
      "",
      `Parsed **${t.files}** files from \`${lcovPath}\`.`,
      "",
      "| Metric | Covered | Total | % |",
      "| ------ | ------: | ----: | -: |",
      `| Lines | ${t.lh} | ${t.lf} | ${pct(t.lh, t.lf)} |`,
      `| Functions | ${t.fnh} | ${t.fnf} | ${pct(t.fnh, t.fnf)} |`,
      `| Branches | ${t.brh} | ${t.brf} | ${pct(t.brh, t.brf)} |`,
    ].join("\n"),
  );
}

main();
