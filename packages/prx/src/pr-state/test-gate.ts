/**
 * The `test-gate` actor (prx-x8ji, epic prx-9zh) — the second Gate.
 *
 * The executor deliberately SKIPS the project checks (typecheck + test) for
 * speed; historically the orchestrator re-ran them by hand before submit. This
 * makes that an enforced, signed gate: it consumes the implement artifact, runs
 * the canonical check steps against the commit, and emits a `gate/v1` verdict
 * (gate=`test`) via the shared {@link runGate}.
 *
 * It runs the FULL canonical steps, not a "touched tests only" subset: a gate
 * must not false-pass, and a change to one source file can break a test that
 * lives nowhere near it. A partial run trades correctness for speed — the wrong
 * trade for a gate.
 *
 * Distinct from the executor's opportunistic `checks/v1` (which only signs on a
 * clean run, so absence ≡ unverified): test-gate ALWAYS emits a signed verdict,
 * so a *failure* is signed evidence too, and it is invokable independently of
 * the implement run as a submit precondition.
 *
 * `runCheck` (a ProcExecutor) and `loadImplement` are injected so the decision
 * logic is testable without spawning real subprocesses.
 */
import type { ProcExecutor } from "@bounded-systems/proc";

import { type ImplementArtifact, implementArtifactEdge } from "../pipeline/implement-artifact.ts";
import { consumeArtifact } from "../pipeline/edge.ts";
import type { AttestDeps } from "../provenance/attest.ts";
import { type GateResult, runGate } from "../provenance/gate.ts";

/** The gate name + verdict slot: `<unit>:gate@test`. */
export const TEST_GATE_NAME = "test";

/** A single check step the gate runs (e.g. `bun run typecheck`). */
export interface TestGateStep {
  readonly command: string;
  readonly args: readonly string[];
}

/** The canonical checks the executor skips — mirrors IMPLEMENT_CHECK_STEPS. */
export const DEFAULT_TEST_GATE_STEPS: readonly TestGateStep[] = [
  { command: "bun", args: ["run", "typecheck"] },
  { command: "bun", args: ["test"] },
];

/** Raised when test-gate is run before there is anything to gate. */
export class TestGateInputError extends Error {
  readonly code = "TEST_GATE_NO_IMPLEMENT";
  constructor(readonly unit: string) {
    super(`test-gate: no implement artifact for ${unit} (run implement before gating its checks)`);
    this.name = "TestGateInputError";
  }
}

/** Injectable seams: real defaults consume the CAS + run local subprocesses. */
export interface TestGateDeps extends AttestDeps {
  /** The check steps to run (defaults to {@link DEFAULT_TEST_GATE_STEPS}). */
  readonly steps?: readonly TestGateStep[];
  /** The executor the steps run through (defaults to a local proc executor). */
  readonly runCheck: ProcExecutor;
  /** Resolve the implement artifact (commit under test). */
  readonly loadImplement?: (unit: string) => Promise<ImplementArtifact | null>;
}

async function defaultLoadImplement(unit: string): Promise<ImplementArtifact | null> {
  const consumed = await consumeArtifact(implementArtifactEdge, unit);
  return consumed.missing ? null : consumed.value;
}

function stepLabel(step: TestGateStep): string {
  return [step.command, ...step.args].join(" ");
}

/**
 * Run the test gate for `unit`: run every check step in `cwd` against the
 * implement commit and emit a signed `gate@test` verdict. Every step runs (no
 * early stop) so the verdict lists ALL failing checks. Throws
 * {@link TestGateInputError} when there is no implement artifact to gate.
 */
export async function runTestGate(
  unit: string,
  cwd: string,
  deps: TestGateDeps,
): Promise<GateResult> {
  const loadImpl = deps.loadImplement ?? defaultLoadImplement;
  const steps = deps.steps ?? DEFAULT_TEST_GATE_STEPS;

  const impl = await loadImpl(unit);
  if (impl === null) throw new TestGateInputError(unit);

  const violations: string[] = [];
  for (const step of steps) {
    const result = await deps.runCheck.exec({
      command: step.command,
      args: [...step.args],
      cwd,
    });
    if (result.status !== 0) {
      violations.push(`${stepLabel(step)} (exit ${result.status})`);
    }
  }
  const pass = violations.length === 0;
  const reason = pass
    ? `all ${steps.length} check step(s) passed`
    : `${violations.length} of ${steps.length} check step(s) failed`;

  return runGate(
    {
      unit,
      gate: TEST_GATE_NAME,
      subjectCommit: impl.commit,
      pass,
      violations,
      reason,
    },
    deps,
  );
}
