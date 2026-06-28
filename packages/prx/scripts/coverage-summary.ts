#!/usr/bin/env bun
/**
 * Summarize an lcov coverage report into a Markdown table.
 *
 * `bun test --coverage --coverage-reporter=lcov` writes `coverage/lcov.info`.
 * This parses it and emits overall line / function / branch coverage. When
 * `GITHUB_STEP_SUMMARY` is set (in CI), the table is appended there so it shows
 * up on the workflow run page. No external service, no third-party action.
 *
 * A missing or empty report prints a note and exits 0 (a report-without-data
 * must not wedge CI). Two gates layer on top:
 *
 *   --min <pct>          GLOBAL: exit 1 when the project-total LINE coverage is
 *                        below <pct>.
 *   --per-file-min <pct> PER-FILE RATCHET: exit 1 when any in-scope SOURCE file
 *                        (`packages/.../src/**`, excluding tests) is below <pct>
 *                        unless it's in PER_FILE_BASELINE. The baseline can only
 *                        SHRINK: a baselined file that has climbed to/above the
 *                        floor (or vanished) is "stale" and also fails, so fixing
 *                        a file forces removing its baseline entry in the same PR.
 *
 * Usage:
 *   bun run scripts/coverage-summary.ts [coverage/lcov.info] [--min 85] [--per-file-min 85]
 */

import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
function flagValue(name: string): number | null {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : null;
}
const minLinePct = flagValue("--min");
const perFileMin = flagValue("--per-file-min");
const flagValueIdxs = new Set<number>();
for (const name of ["--min", "--per-file-min"]) {
  const i = args.indexOf(name);
  if (i >= 0) flagValueIdxs.add(i + 1);
}
const lcovPath =
  args.find((a, i) => !a.startsWith("--") && !flagValueIdxs.has(i)) ?? "coverage/lcov.info";

// PER-FILE RATCHET baseline: source files allowed below the per-file floor, each
// with a reason. The gate fails if a NON-baselined source file drops below the
// floor, or if a baselined entry goes stale (now at/above the floor, or gone) —
// so the list only shrinks. Repo-relative paths (normalized to `packages/...`).
const PER_FILE_BASELINE = new Set<string>([
  "packages/prx/src/pr-state/tui.ts", // deprecated TUI surface
  "packages/prx/src/pr-state/cli.ts", // 23k-line CLI, mid §4 decomposition
  "packages/prx/src/pr-state/cli-spawn.ts", // cli.ts spawn helpers, decomposed alongside it
  "packages/prx/src/triage/actors.ts", // thin XState wrappers; haiku-headless-actor reshape pending (#502)
  "packages/prx/src/triage/type-pass.ts", // inline headless haiku call; moves to a headless actor (#502)
  "packages/prx/src/triage/prioritize-bulk.ts", // inline headless haiku call; moves to a headless actor (#502)
  "packages/prx/src/tools/agent_doctor.ts", // spawn-bound: real SDK probe + spawnCapture runner can't run deterministically in CI
  // GH-664: pre-existing gaps that the broken coverage gate (no lcov) hid until
  // it was restored. Each is wiring/spawn/fs-bound; improve separately.
  "packages/prx/src/fetch/slack-sync.ts", // 46% — `prx fetch slack` composition root — injectable seams; integration paths uncovered
  "packages/prx/src/machine/claude_capabilities.ts", // 47% — spawn-bound: probes the real `claude` binary via spawnCapture, non-deterministic in CI
  "packages/prx/src/pr-state/session-finder.ts", // 63% — fs/env-bound session discovery extracted from cli.ts (itself baselined)
  "packages/prx/src/slack/scout-cli.ts", // 69% — slack read-surface composition root — authority/credential wiring
  // Reformat line-accounting (#693): wrapping long lines nudged these borderline
  // files just under the floor — same tests, same behavior, only the line count
  // (denominator) moved. Revisit with real tests, then remove.
  "packages/prx/src/machine/gc/cli.ts", // 81% (was 86%) — reformat line-accounting
  "packages/prx/src/intake/intake-status.ts", // 83% — reformat line-accounting
  "packages/prx/src/derive/cli.ts", // 84% — reformat line-accounting
  "packages/prx/src/pr-state/dolt-reconcile.ts", // 85% — reformat line-accounting (rounding)
  "packages/prx/src/room/pod-up-verb.ts", // 77% — run() calls live launchPod (podman); covered by live e2e, not unit test
  "packages/prx/src/room/pod-secrets-verb.ts", // 79% — run() calls live podman (ensurePodSecrets); logic covered in pod-secrets.test.ts, not unit-tested here
]);

type Totals = {
  lf: number;
  lh: number;
  fnf: number;
  fnh: number;
  brf: number;
  brh: number;
  files: number;
};
type FileCov = { path: string; lf: number; lh: number };

function normalizePath(sf: string): string {
  const m = sf.match(/(packages\/.*)$/);
  return m ? m[1]! : sf;
}

// In-scope for the per-file gate: product source only — `.../src/**`, no tests.
function isGatedSource(path: string): boolean {
  return (
    path.includes("/src/") &&
    path.endsWith(".ts") &&
    !path.endsWith(".test.ts") &&
    !path.includes("/__tests__/")
  );
}

function parse(lcov: string): { totals: Totals; perFile: FileCov[] } {
  const t: Totals = { lf: 0, lh: 0, fnf: 0, fnh: 0, brf: 0, brh: 0, files: 0 };
  const perFile: FileCov[] = [];
  let cur: FileCov | null = null;
  for (const line of lcov.split("\n")) {
    const [tag, rawValue] = line.split(":", 2);
    const n = Number(rawValue);
    switch (tag) {
      case "SF":
        t.files += 1;
        cur = { path: normalizePath(rawValue ?? ""), lf: 0, lh: 0 };
        break;
      case "LF":
        t.lf += n;
        if (cur) cur.lf = n;
        break;
      case "LH":
        t.lh += n;
        if (cur) cur.lh = n;
        break;
      case "FNF":
        t.fnf += n;
        break;
      case "FNH":
        t.fnh += n;
        break;
      case "BRF":
        t.brf += n;
        break;
      case "BRH":
        t.brh += n;
        break;
    }
    if (line === "end_of_record" && cur) {
      perFile.push(cur);
      cur = null;
    }
  }
  return { totals: t, perFile };
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
      process.stderr.write(
        `Warning: failed to append coverage summary to \`${summary}\`: ${String(error)}\n`,
      );
    }
  }
}

function main(): void {
  // A gate was requested iff a threshold flag is present. When gating, a missing
  // or empty report is a FAILURE (fail-closed): a coverage run that produced no
  // data must not pass as green — otherwise a broken `bun test --coverage` step
  // silently neuters the floor (GH-664). Without any gate flag this stays a
  // report-only summary that won't wedge CI on a missing report.
  const gating =
    (minLinePct !== null && Number.isFinite(minLinePct)) ||
    (perFileMin !== null && Number.isFinite(perFileMin));

  let lcov: string;
  try {
    lcov = readFileSync(lcovPath, "utf8");
  } catch {
    emit(`### Coverage\n\nNo coverage report found at \`${lcovPath}\`.`);
    if (gating) {
      emit(
        `\n❌ **Coverage gate failed (fail-closed):** the coverage run produced no \`${lcovPath}\` — ` +
          `treating absent coverage as a breach. Check the "Run tests with coverage" step.`,
      );
      process.exit(1);
    }
    emit("Skipping (no gate requested).");
    return;
  }

  const { totals: t, perFile } = parse(lcov);

  if (gating && t.files === 0) {
    emit(
      `### Coverage\n\n❌ **Coverage gate failed (fail-closed):** \`${lcovPath}\` has no file records ` +
        `(empty report) — the coverage run produced no data. Check the "Run tests with coverage" step.`,
    );
    process.exit(1);
  }
  const lineParts = [
    "### Coverage",
    "",
    `Parsed **${t.files}** files from \`${lcovPath}\`.`,
    "",
    "| Metric | Covered | Total | % |",
    "| ------ | ------: | ----: | -: |",
    `| Lines | ${t.lh} | ${t.lf} | ${pct(t.lh, t.lf)} |`,
    `| Functions | ${t.fnh} | ${t.fnf} | ${pct(t.fnh, t.fnf)} |`,
    `| Branches | ${t.brh} | ${t.brf} | ${pct(t.brh, t.brf)} |`,
  ];
  emit(lineParts.join("\n"));

  let failed = false;

  // ── global line-coverage gate ────────────────────────────────────────────
  if (minLinePct !== null && Number.isFinite(minLinePct)) {
    const linePct = t.lf === 0 ? 0 : (t.lh / t.lf) * 100;
    if (linePct < minLinePct) {
      emit(
        `\n❌ **Global coverage gate failed:** line coverage ${linePct.toFixed(2)}% is below the ${minLinePct}% minimum.`,
      );
      failed = true;
    } else {
      emit(
        `\n✅ Global coverage gate passed: line coverage ${linePct.toFixed(2)}% ≥ ${minLinePct}%.`,
      );
    }
  }

  // ── per-file ratchet gate ────────────────────────────────────────────────
  if (perFileMin !== null && Number.isFinite(perFileMin)) {
    const filePct = (f: FileCov) => (f.lf === 0 ? 100 : (f.lh / f.lf) * 100);
    const gated = perFile.filter((f) => isGatedSource(f.path));
    const seen = new Set(gated.map((f) => f.path));

    // New offenders: in-scope source below the floor and NOT baselined.
    const violations = gated.filter(
      (f) => filePct(f) < perFileMin && !PER_FILE_BASELINE.has(f.path),
    );
    // Stale baseline: a baselined path that is now at/above the floor, or absent
    // from the report (deleted/renamed). The list may only shrink.
    const stale = [...PER_FILE_BASELINE].filter((p) => {
      const f = gated.find((g) => g.path === p);
      return !seen.has(p) || (f !== undefined && filePct(f) >= perFileMin);
    });

    if (violations.length > 0) {
      emit(
        `\n❌ **Per-file coverage gate failed:** ${violations.length} source file(s) below ${perFileMin}% (not baselined):`,
      );
      for (const f of violations.sort((a, b) => filePct(a) - filePct(b))) {
        emit(`  - ${f.path} — ${filePct(f).toFixed(2)}%`);
      }
      emit(
        `  Raise their coverage, or add them to PER_FILE_BASELINE in coverage-summary.ts with a reason.`,
      );
      failed = true;
    }
    if (stale.length > 0) {
      emit(
        `\n❌ **Stale per-file baseline:** ${stale.length} entr(y/ies) at/above ${perFileMin}% or missing — remove them (the baseline only shrinks):`,
      );
      for (const p of stale.sort()) emit(`  - ${p}`);
      failed = true;
    }
    if (violations.length === 0 && stale.length === 0) {
      emit(
        `\n✅ Per-file coverage gate passed: every source file ≥ ${perFileMin}% (or baselined), baseline has ${PER_FILE_BASELINE.size} entr(y/ies).`,
      );
    }
  }

  if (failed) process.exit(1);
}

main();
