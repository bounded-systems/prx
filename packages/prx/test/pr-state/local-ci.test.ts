// `prx ci` (GH-955) — spec-building + phase-running internals.
//
// runCiPhases is already covered by callers via the injected runPhaseFn seam;
// these tests drive the spawn-bound internals (phaseSpec, the SHA bake, the
// dist-dir prepare, and runPhase's plain/json arms) through the GH-955
// `{ run, capture }` runner seam — no real bun/git invocation.

import { describe, expect, test } from "bun:test";
import type { CommandResult, CommandRunner } from "@bounded-systems/proc";

import {
  CI_PHASES,
  phaseSpec,
  runCiPhases,
  runPhase,
  type CiPhase,
  type LocalCiRunners,
  type PhaseResult,
} from "../../src/pr-state/local-ci.ts";

const result = (status: number, stdout = "", stderr = ""): CommandResult => ({ status, stdout, stderr });

/** A capturing fake runner that records every argv it was handed. */
function recordingRunner(res: CommandResult): { fn: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const fn: CommandRunner = (cmd) => {
    calls.push(cmd);
    return res;
  };
  return { fn, calls };
}

function sink(): { out: string[]; err: string[]; output: { log: (l: string) => void; error: (l: string) => void } } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, output: { log: (l) => out.push(l), error: (l) => err.push(l) } };
}

describe("phaseSpec", () => {
  test("each lightweight phase maps to its canonical argv", () => {
    expect(phaseSpec("install").argv).toEqual(["bun", "install", "--frozen-lockfile"]);
    expect(phaseSpec("typecheck").argv).toEqual(["bunx", "tsc", "--noEmit"]);
    expect(phaseSpec("docs").argv).toEqual(["bun", "run", "docs:check"]);
    expect(phaseSpec("test").argv).toEqual(["bun", "test"]);
  });

  test("build bakes the git SHA from the capture seam into the --define", () => {
    const capture = recordingRunner(result(0, "abc123def456\n"));
    const spec = phaseSpec("build", { capture: capture.fn });
    expect(capture.calls[0]).toEqual(["git", "rev-parse", "--short=12", "HEAD"]);
    expect(spec.argv).toContain(`__PRX_BUILD_GIT_SHA__="abc123def456"`);
    expect(spec.argv).toContain("--compile");
  });

  test("build bakes an empty SHA when git rev-parse fails", () => {
    const capture = recordingRunner(result(1, "", "fatal"));
    const spec = phaseSpec("build", { capture: capture.fn });
    expect(spec.argv).toContain(`__PRX_BUILD_GIT_SHA__=""`);
  });

  test("build's prepare ensures the dist dir through the run seam", () => {
    const run = recordingRunner(result(0));
    const spec = phaseSpec("build", { run: run.fn, capture: recordingRunner(result(0, "x")).fn });
    spec.prepare?.();
    expect(run.calls).toContainEqual(["mkdir", "-p", "dist"]);
  });
});

describe("runPhase", () => {
  test("plain format dispatches via the run seam and stamps STARTED/PASSED", () => {
    const run = recordingRunner(result(0));
    const s = sink();
    const deps: LocalCiRunners = { run: run.fn };
    const r = runPhase("typecheck", "plain", s.output, deps);
    expect(r).toEqual({ phase: "typecheck", status: 0, durationMs: r.durationMs });
    expect(run.calls[0]).toEqual(["bunx", "tsc", "--noEmit"]);
    expect(s.err.some((l) => l.startsWith("LOCAL_CI_STARTED phase=typecheck"))).toBe(true);
    expect(s.err.some((l) => l.startsWith("LOCAL_CI_PASSED phase=typecheck"))).toBe(true);
  });

  test("json format dispatches via the capture seam and carries stdout/stderr", () => {
    const capture = recordingRunner(result(2, "out-bytes", "err-bytes"));
    const s = sink();
    const r = runPhase("test", "json", s.output, { capture: capture.fn });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("out-bytes");
    expect(r.stderr).toBe("err-bytes");
    expect(s.err.some((l) => l.startsWith("LOCAL_CI_FAILED phase=test"))).toBe(true);
  });

  test("a build phase runs its prepare before dispatching", () => {
    const run = recordingRunner(result(0));
    const capture = recordingRunner(result(0, "deadbeef0000"));
    const s = sink();
    const r = runPhase("build", "plain", s.output, { run: run.fn, capture: capture.fn });
    expect(r.status).toBe(0);
    // mkdir prepare + the build dispatch both went through the run seam.
    expect(run.calls).toContainEqual(["mkdir", "-p", "dist"]);
    expect(run.calls.some((c) => c[0] === "bun" && c[1] === "build")).toBe(true);
  });

  test("CI_PHASES is the canonical ordered pipeline", () => {
    expect([...CI_PHASES]).toEqual(["install", "typecheck", "docs", "build", "test"]);
  });
});

describe("runCiPhases", () => {
  const fakePhase = (statuses: Partial<Record<CiPhase, number>>) =>
    (phase: CiPhase): PhaseResult => ({ phase, status: statuses[phase] ?? 0, durationMs: 1 });

  test("runs the full pipeline and reports a passing plain summary", () => {
    const s = sink();
    const { code, results } = runCiPhases({ format: "plain" }, s.output, fakePhase({}));
    expect(code).toBe(0);
    expect(results.map((r) => r.phase)).toEqual([...CI_PHASES]);
    expect(s.err.some((l) => l.includes("passed 5 of 5"))).toBe(true);
  });

  test("breaks at the first failing phase and reports it", () => {
    const s = sink();
    const { code, results } = runCiPhases({ format: "plain" }, s.output, fakePhase({ docs: 1 }));
    expect(code).toBe(1);
    // install, typecheck, docs ran; build/test never reached.
    expect(results.map((r) => r.phase)).toEqual(["install", "typecheck", "docs"]);
    expect(s.err.some((l) => l.includes("failed at phase=docs (passed 2 of 5)"))).toBe(true);
  });

  test("a single-phase run honors opts.phase", () => {
    const s = sink();
    const { results } = runCiPhases({ phase: "test", format: "plain" }, s.output, fakePhase({}));
    expect(results.map((r) => r.phase)).toEqual(["test"]);
  });

  test("json format emits a phases array", () => {
    const s = sink();
    const { code } = runCiPhases({ format: "json" }, s.output, fakePhase({ test: 3 }));
    expect(code).toBe(1);
    const payload = JSON.parse(s.out[0] ?? "{}");
    expect(payload.phases).toHaveLength(5);
    expect(payload.phases.at(-1)).toMatchObject({ phase: "test", status: 3 });
  });
});
