// GH-1768 — transition-log replay harness.
//
// Validates two of the issue's evaluation criteria:
//   • "Deterministic derivation" — re-running on the same input yields
//     byte-identical fact lists and provenance.
//   • "Replay-friendly derivations" — walking a transition log step by
//     step does not cause derived predicates to thrash; intermediate
//     facts converge monotonically to the end-state when the log is
//     replayed in order.
//
// The harness operates on an *external* sequence of `ProjectInput`
// snapshots — one per timestep — plus a final snapshot. Each step the
// caller wants to assert on is run through `projectAndRun`; the
// emitted ready/drift sets are recorded. A second pass over the same
// inputs must produce identical outputs.

import { allRules, projectAndRun } from "./index.ts";
import { factKey, type Fact } from "./engine.ts";
import type { ProjectInput } from "./project.ts";

export type ReplayStepSummary = {
  step: number;
  facts: string[];
  ready: string[];
  drift: string[];
};

export type ReplayReport = {
  steps: ReplayStepSummary[];
  deterministic: boolean;
};

function summarize(input: ProjectInput, step: number): ReplayStepSummary {
  const { view } = projectAndRun(input, { rules: allRules });
  const facts = view.facts.all().map(factKey).sort();
  const ready = view.facts
    .get("ready")
    .map((f) => String(f.args[0]))
    .sort();
  const drift = view.facts
    .get("drift")
    .map((f) => `${String(f.args[0])}/${String(f.args[1])}`)
    .sort();
  return { step, facts, ready, drift };
}

export function replay(inputs: ProjectInput[]): ReplayReport {
  const first = inputs.map((input, i) => summarize(input, i));
  const second = inputs.map((input, i) => summarize(input, i));
  let deterministic = true;
  for (let i = 0; i < first.length; i++) {
    const a = first[i]!;
    const b = second[i]!;
    if (
      a.facts.length !== b.facts.length ||
      a.facts.some((f, idx) => f !== b.facts[idx]) ||
      a.ready.join(",") !== b.ready.join(",") ||
      a.drift.join(",") !== b.drift.join(",")
    ) {
      deterministic = false;
      break;
    }
  }
  return { steps: first, deterministic };
}

export type MonotonicityFinding = {
  step: number;
  regressedFacts: string[];
};

/**
 * Checks that the set of facts derived at each step is a superset of
 * the previous step's set, restricted to predicates the caller marks
 * as monotonic. Defaults to the structural relations (`issue`, `phase`,
 * `pr`, `branch`, `worktree`) — these grow as a log replays through
 * lifecycle creation events. Lifecycle-terminal events (cleaned,
 * merged) violate strict monotonicity by design; the caller passes a
 * predicate to filter.
 */
export function checkMonotonicity(
  inputs: ProjectInput[],
  monotonicRelations: readonly string[],
): MonotonicityFinding[] {
  const findings: MonotonicityFinding[] = [];
  let prev: Set<string> | null = null;
  for (let i = 0; i < inputs.length; i++) {
    const { view } = projectAndRun(inputs[i]!, { rules: allRules });
    const here = new Set<string>();
    for (const f of view.facts.all()) {
      if (monotonicRelations.includes(f.relation)) here.add(factKey(f));
    }
    if (prev !== null) {
      const regressed: string[] = [];
      for (const k of prev) {
        if (!here.has(k)) regressed.push(k);
      }
      if (regressed.length > 0) findings.push({ step: i, regressedFacts: regressed });
    }
    prev = here;
  }
  return findings;
}

export function getFactByRelation(facts: Fact[], relation: string): Fact[] {
  return facts.filter((f) => f.relation === relation);
}
