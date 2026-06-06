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
// codebase-wide zero cycles — there are unrelated pre-existing cycles (tracked
// in docs/code-health.md; the `no-circular` rule is `warn` until ratcheted).
//
// Uses dependency-cruiser (the project's cycle tool — madge was retired). The
// cruise is subprocess-bound and grows with src/, so give it real headroom.

import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";

const TIMEOUT_MS = 90_000;

describe("intake↔triage cycle (GH-1687)", () => {
  test("no circular import involves src/intake/intake.ts", () => {
    const result = spawnSync(
      "bunx",
      [
        "depcruise",
        "packages/prx/src",
        "--config",
        ".dependency-cruiser.cjs",
        "--output-type",
        "json",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: TIMEOUT_MS - 5_000, maxBuffer: 64 * 1024 * 1024 },
    );
    const parsed = JSON.parse(result.stdout || "{}");
    const violations: Array<{ rule?: { name?: string }; from?: string; to?: string; cycle?: Array<string | { name?: string }> }> =
      parsed.summary?.violations ?? [];

    const touchesIntake = (s?: string) => !!s && /intake\/intake\.ts/i.test(s);
    const offending = violations
      .filter((v) => v.rule?.name === "no-circular")
      .filter((v) => {
        if (touchesIntake(v.from) || touchesIntake(v.to)) return true;
        return (v.cycle ?? []).some((c) => touchesIntake(typeof c === "string" ? c : c.name));
      })
      .map((v) => `${v.from} → ${v.to}`);

    expect(
      offending,
      `expected no cycle to involve src/intake/intake.ts; saw:\n${offending.join("\n")}`,
    ).toEqual([]);
  }, TIMEOUT_MS);
});
