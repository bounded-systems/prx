import { setup } from "xstate";
import type { WorkflowPhase } from "@bounded-systems/machine-schema";

// The live merge gate. A UoW may enter `ready_to_merge` only when review
// evidence is approved AND test/CI evidence passed — the same gate the audit
// layer enforces (`requiredArtifactTypesForPhase("ready_to_merge")` =
// test_run + review_bundle, status `passed`), projected onto the derived
// review/ci axes (review_bundle passed ↔ review approved; test_run passed ↔
// ci passed).
//
// No ambient authority: the guard reads only derived context, never the
// triggering event. An actor cannot force the transition by sending APPROVE /
// MERGEABILITY_CLEAN — the context (set by prior review/ci events, themselves
// derived from artifacts) must already satisfy the gate. This is the
// transition-level form of "authority lives in artifacts, not actors".
//
// The provenance axis (GH-2249, invariant I-PROV1) is the merge-guard
// re-verification verdict for the UoW's required ledger derivations at the head
// commit:
//   - "verified"  → enforcement on; every required derivation carries an
//                   envelope that verifies under the resolved Verifier.
//   - "unsigned"  → enforcement on; a required derivation is absent / unsigned /
//                   fails verification. The only value that BLOCKS the gate.
//   - "unchecked" → enforcement off (PRX_REQUIRE_SIGNED_DERIVATIONS unset) or
//                   not yet computed. Never blocks — behaviour unchanged.
// Flag-gating lives in the async projection that computes this axis, NOT in the
// guard: the guard stays synchronous and reads only derived context. An absent
// axis is treated as "unchecked" (non-blocking) so a context that predates the
// axis is backward compatible.
export type ProvenanceAxis = "verified" | "unsigned" | "unchecked";

export type MergeGateContext = {
  readonly review: string;
  readonly ci: string;
  readonly provenance?: ProvenanceAxis;
};

export function canEnterReadyToMerge(ctx: MergeGateContext): boolean {
  return (
    ctx.review === "approved" &&
    ctx.ci === "passed" &&
    ctx.provenance !== "unsigned"
  );
}


const workflowBackboneStates = {
  cleaned: {
    on: {
      WORKTREE_CREATED: "worktree_created",
      BRANCH_CREATED: "branch_created",
    },
  },
  merged: {
    on: {
      WORKTREE_REMOVED: "cleaned",
      BRANCH_DELETED: "cleaned",
      PR_CLOSED: "closed",
    },
  },
  closed: {
    on: {
      PR_REOPENED: "no_worktree",
      REOPEN: "no_worktree",
    },
  },
  no_worktree: {
    on: {
      WORKTREE_CREATED: "worktree_created",
    },
  },
  worktree_created: {
    on: {
      WORKTREE_REMOVED: "no_worktree",
      BRANCH_CREATED: "branch_created",
    },
  },
  branch_created: {
    on: {
      BRANCH_DELETED: "worktree_created",
      PUSH_COMMIT: "committing",
    },
  },
  committing: {
    on: {
      PUSH_COMMIT: "committing",
      REMOTE_BRANCH_PUBLISHED: "pushed",
      BRANCH_DELETED: "worktree_created",
    },
  },
  pushed: {
    on: {
      PR_OPENED: "draft",
      SUBMIT: "draft",
      PUSH_COMMIT: "committing",
    },
  },
  draft: {
    on: {
      PR_READY_FOR_REVIEW: "ready_for_review",
      REQUEST_REVIEW: "in_review",
      REVIEW_REQUESTED: "in_review",
      PR_CLOSED: "closed",
      CLOSE: "closed",
      PUSH_COMMIT: "draft",
    },
  },
  changes_requested: {
    on: {
      REQUEST_REVIEW: "in_review",
      REVIEW_REQUESTED: "in_review",
      PUSH_COMMIT: "in_review",
      PR_CLOSED: "closed",
      CLOSE: "closed",
    },
  },
  waiting_on_ci: {
    on: {
      REMOTE_CI_PASSED: "in_review",
      LOCAL_CI_PASSED: "in_review",
      CI_PASS: "in_review",
      REMOTE_CI_FAILED: "blocked",
      LOCAL_CI_FAILED: "blocked",
      CI_FAIL: "blocked",
      PUSH_COMMIT: "waiting_on_ci",
    },
  },
  blocked: {
    on: {
      PUSH_COMMIT: "waiting_on_ci",
      REMOTE_CI_QUEUED: "waiting_on_ci",
      CI_QUEUE: "waiting_on_ci",
      REMOTE_CI_STARTED: "waiting_on_ci",
      CI_START: "waiting_on_ci",
      MERGEABILITY_CLEAN: "in_review",
      REVIEW_APPROVED: "in_review",
      APPROVE: "in_review",
    },
  },
  ready_to_merge: {
    on: {
      PR_MERGED: "merged",
      MERGE: "merged",
      CHANGES_REQUESTED: "changes_requested",
      REQUEST_CHANGES: "changes_requested",
      PUSH_COMMIT: "in_review",
      AUTOMERGE_ENABLED: "automerge_enabled",
    },
  },
  automerge_enabled: {
    on: {
      PR_MERGED: "merged",
      MERGE: "merged",
      AUTOMERGE_DISABLED: "ready_to_merge",
      CHANGES_REQUESTED: "changes_requested",
      REQUEST_CHANGES: "changes_requested",
      PUSH_COMMIT: "in_review",
    },
  },
  ready_for_review: {
    on: {
      REQUEST_REVIEW: "in_review",
      REVIEW_REQUESTED: "in_review",
      PR_CONVERTED_TO_DRAFT: "draft",
      CONVERT_TO_DRAFT: "draft",
      PUSH_COMMIT: "ready_for_review",
    },
  },
  in_review: {
    on: {
      CHANGES_REQUESTED: "changes_requested",
      REQUEST_CHANGES: "changes_requested",
      REMOTE_CI_STARTED: "waiting_on_ci",
      LOCAL_CI_STARTED: "waiting_on_ci",
      CI_START: "waiting_on_ci",
      REMOTE_CI_QUEUED: "waiting_on_ci",
      CI_QUEUE: "waiting_on_ci",
      REVIEW_APPROVED: { target: "ready_to_merge", guard: { type: "mergeGate" } },
      APPROVE: { target: "ready_to_merge", guard: { type: "mergeGate" } },
      MERGEABILITY_CLEAN: { target: "ready_to_merge", guard: { type: "mergeGate" } },
      PR_CLOSED: "closed",
      CLOSE: "closed",
      PUSH_COMMIT: "in_review",
    },
  },
} as const;

// Exhaustiveness: every WorkflowPhase must have a backbone state. Checks the
// key set without constraining transition value types (so XState's setup()
// can infer the guarded transitions precisely).
const _phaseCoverage: Record<WorkflowPhase, unknown> = workflowBackboneStates;
void _phaseCoverage;

/**
 * Parallel child of {@link prSystemMachine}: artifact / parity phases aligned with
 * `phasePrecedence` in `state.ts`. The entry into `ready_to_merge` is guarded
 * live by {@link canEnterReadyToMerge} (the merge gate); the remaining
 * transitions are documentary (parity chain and raw snapshots remain
 * authoritative).
 */
export const workflowBackboneParallelRegion = {
  initial: "no_worktree",
  states: workflowBackboneStates,
} as const;

/** Standalone view of the same backbone for `prx model` / introspection. The
 *  merge gate reads review/ci context, so `ready_to_merge` is reachable at
 *  runtime only once both axes satisfy {@link canEnterReadyToMerge}. */
export const workflowMachine = setup({
  types: { context: {} as MergeGateContext },
  guards: { mergeGate: ({ context }) => canEnterReadyToMerge(context) },
}).createMachine({
  id: "workflowBackbone",
  initial: workflowBackboneParallelRegion.initial,
  context: { review: "none", ci: "pending" },
  states: workflowBackboneParallelRegion.states,
});
