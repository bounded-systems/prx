// GH-1821 — TransitionContract instances.
//
// Two demonstrative transitions, one per axis. The trinity must keep the two
// axes distinct so guards never conflate role lifecycle with the workflow
// backbone — the contracts carry `axis: "role" | "workflow"` for that reason.

import { transitionContractSchema, type TransitionContract } from "../contracts.ts";

// Role axis. The classic example pair from the spike: a tester run produced
// a passed TestRun, no BlockerReport in the graph — the reviewer slot opens.
const testingToReviewing: TransitionContract = transitionContractSchema.parse({
  axis: "role",
  fromPhase: "testing",
  toPhase: "reviewing",
  requiredArtifact: "test_run",
  requiredStatus: "passed",
  forbiddenArtifacts: ["blocker_report"],
  guardId: "testToReview.requireTestRunPassed",
});

// Workflow-backbone axis. Re-uses the live `assertInvariants` I04 check —
// the trinity *describes* the existing invariant without changing it.
const inReviewToReadyToMerge: TransitionContract = transitionContractSchema.parse({
  axis: "workflow",
  fromPhase: "in_review",
  toPhase: "ready_to_merge",
  requiredArtifact: "raw_state_v1",
  requiredStatus: "present",
  forbiddenArtifacts: [],
  guardId: "inReviewToReadyToMerge.delegateI04",
});

// GH-1822 — lifecycle axis. Two demonstrative transitions in the Scrum-fit
// wrapper. `map → delegate` gates the handoff from work-shaping into work-
// assignment; `delegate → execute` is the first cross-axis transition,
// authorizing entry into the role-axis chain (planning → executing → …).

const mapToDelegate: TransitionContract = transitionContractSchema.parse({
  axis: "lifecycle",
  fromPhase: "map",
  toPhase: "delegate",
  requiredArtifact: "work_map",
  requiredStatus: "present",
  forbiddenArtifacts: ["blocker_report"],
  guardId: "mapToDelegate.requireWorkMap",
});

const delegateToExecute: TransitionContract = transitionContractSchema.parse({
  axis: "lifecycle",
  fromPhase: "delegate",
  toPhase: "execute",
  requiredArtifact: "delegation_record",
  requiredStatus: "present",
  forbiddenArtifacts: [],
  guardId: "delegateToExecute.requireDelegationRecord",
});

const entries: TransitionContract[] = [
  testingToReviewing,
  inReviewToReadyToMerge,
  mapToDelegate,
  delegateToExecute,
];

export function transitionKey(t: TransitionContract): string {
  return `${t.axis}:${t.fromPhase}->${t.toPhase}`;
}

export const transitionRegistry: Readonly<Record<string, TransitionContract>> = Object.freeze(
  Object.fromEntries(entries.map((entry) => [transitionKey(entry), entry])),
);

export function listTransitionContracts(): readonly TransitionContract[] {
  return entries;
}

export function getTransitionContract(key: string): TransitionContract | undefined {
  return transitionRegistry[key];
}
