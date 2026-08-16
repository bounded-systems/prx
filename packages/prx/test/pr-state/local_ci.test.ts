// GH-352: `runCiPhases` surfaces per-phase results so the CLI can attest the
// phases that PASSED even on a partial (failed) run — a failure stops the loop
// but still leaves verified evidence for the phases before it. The phase
// executor is injected so this runs without the real (heavy) install/typecheck/
// build/test phases.
import { describe, expect, test } from "bun:test";

import {
  CI_PHASES,
  runCiPhases,
  type CiPhase,
  type PhaseResult,
} from "../../src/pr-state/local-ci.ts";

const sink = { log: () => {}, error: () => {} };

/** A fake phase runner driven by a status map; defaults to pass (status 0). */
function fakeRunner(statuses: Partial<Record<CiPhase, number>>) {
  return (phase: CiPhase): PhaseResult => ({
    phase,
    status: statuses[phase] ?? 0,
    durationMs: 1,
  });
}

describe("runCiPhases — surfaces per-phase results for partial-pass attestation", () => {
  test("all green: code 0, a result per phase, all passed", () => {
    const { code, results } = runCiPhases({ format: "plain" }, sink, fakeRunner({}));
    expect(code).toBe(0);
    expect(results.map((r) => r.phase)).toEqual([...CI_PHASES]);
    expect(results.every((r) => r.status === 0)).toBe(true);
  });

  test("partial: stops at the first failure, but the passed phases are surfaced", () => {
    // install, typecheck pass; docs fails ⇒ build/test never run.
    const { code, results } = runCiPhases({ format: "plain" }, sink, fakeRunner({ docs: 1 }));
    expect(code).toBe(1);
    expect(results.map((r) => r.phase)).toEqual(["install", "typecheck", "docs"]);

    const passed = results.filter((r) => r.status === 0).map((r) => r.phase);
    expect(passed).toEqual(["install", "typecheck"]); // exactly what the CLI attests
  });

  test("single --phase failure surfaces that phase as not-passed (nothing to attest)", () => {
    const { code, results } = runCiPhases(
      { phase: "test", format: "plain" },
      sink,
      fakeRunner({ test: 1 }),
    );
    expect(code).toBe(1);
    expect(results.filter((r) => r.status === 0)).toHaveLength(0);
  });
});
