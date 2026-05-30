// Regression guard for GH-1687 — keep the intake/intake.ts module out of
// any import cycle that re-enters its own dependency tree at init time.
//
// The original bug: `src/intake/intake.ts` imported from `src/triage/labels.ts`
// and `src/triage/label-vocab.ts`, while `src/triage/schemas/promote-children.ts`
// imported `INTAKE_TYPES` back from `src/intake/intake.ts`. On CI Linux bun
// the closing edge fired mid-init through the audit-sink schema, tripping
// four ES-module TDZ failures across ~213 tests. Moving the vocab constants
// to a leaf module (`src/intake/types.ts`) broke the back-edge.
//
// This test asserts the specific edge stays broken. It does NOT assert
// codebase-wide zero cycles — there are unrelated pre-existing cycles
// outside this PR's scope. A follow-up issue can flip madge into a
// global gate once those are addressed.

import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";

// `madge --circular` parses every .ts under src/ — a few seconds locally,
// ~5s+ on CI, and it creeps up as src/ grows. That brushed bun's default 5s
// per-test limit and started flaking on green PRs (the run TIMED OUT; it never
// found a cycle). Give the (legitimately slow, subprocess-bound) check real
// headroom + a matching spawn timeout so a genuinely hung madge still fails
// fast rather than hanging the suite.
const MADGE_TIMEOUT_MS = 60_000;

describe("intake↔triage cycle (GH-1687)", () => {
  test("madge reports no cycle that touches src/intake/intake.ts", () => {
    const result = spawnSync(
      "bunx",
      ["madge", "--circular", "--extensions", "ts", "src/"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: MADGE_TIMEOUT_MS - 5_000 },
    );
    // madge exits non-zero when cycles are found; we parse stdout either way.
    const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const offending = out
      .split(/\r?\n/)
      .filter((line) => /intake\/intake\.ts/i.test(line));
    expect(
      offending,
      `expected no cycle to involve src/intake/intake.ts; saw:\n${offending.join("\n")}`,
    ).toEqual([]);
  }, MADGE_TIMEOUT_MS);
});
