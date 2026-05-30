import { assign, createMachine, setup } from "xstate";

import {
  canEnterReadyToMerge,
  workflowBackboneParallelRegion,
  type ProvenanceAxis,
} from "./workflow.ts";

export const lifecycleStates = [
  "drafting",
  "validating",
  "ready_for_review",
  "in_review",
  "changes_requested",
  "merge_ready",
  "merged",
] as const;

export type LifecycleState = (typeof lifecycleStates)[number];

export const prSkillNames = [
  "pr-prime",
  "pr-next",
  "pr-checklist",
  "pr-test-discipline",
  "pr-tickets",
  "pr-why",
  "pr-validate",
  "pr-comments",
  "pr-fix",
  "pr-ready",
  "pr-concerns",
  "pr-contract",
  "pr-cli",
] as const;

export type PrSkillName = (typeof prSkillNames)[number];

export type SkillEventDefinition =
  | {
      kind: "transition";
      event: string;
      to: LifecycleState;
    }
  | {
      kind: "observe";
      event: string;
    };

const skillEventMap: Record<PrSkillName, SkillEventDefinition> = {
  "pr-prime": { kind: "observe", event: "SKILL_PRIME" },
  "pr-next": { kind: "observe", event: "SKILL_NEXT" },
  "pr-checklist": { kind: "transition", event: "SKILL_CHECKLIST", to: "validating" },
  "pr-test-discipline": { kind: "transition", event: "SKILL_TEST_DISCIPLINE", to: "validating" },
  "pr-tickets": { kind: "observe", event: "SKILL_TICKETS" },
  "pr-why": { kind: "transition", event: "SKILL_WHY", to: "validating" },
  "pr-validate": { kind: "transition", event: "SKILL_VALIDATE", to: "validating" },
  "pr-comments": { kind: "transition", event: "SKILL_COMMENTS", to: "in_review" },
  "pr-fix": { kind: "transition", event: "SKILL_FIX", to: "drafting" },
  "pr-ready": { kind: "transition", event: "SKILL_READY", to: "ready_for_review" },
  "pr-concerns": { kind: "transition", event: "SKILL_CONCERNS", to: "in_review" },
  "pr-contract": { kind: "observe", event: "SKILL_CONTRACT" },
  "pr-cli": { kind: "observe", event: "SKILL_CLI" },
};

export const readyStates = new Set<LifecycleState>([
  "ready_for_review",
  "in_review",
  "changes_requested",
  "merge_ready",
  "merged",
]);

type LifecycleEvent =
  | { type: "TO_DRAFTING" }
  | { type: "TO_VALIDATING" }
  | { type: "TO_READY_FOR_REVIEW" }
  | { type: "TO_IN_REVIEW" }
  | { type: "TO_CHANGES_REQUESTED" }
  | { type: "TO_MERGE_READY" }
  | { type: "TO_MERGED" };

const stateToEvent: Record<LifecycleState, LifecycleEvent["type"]> = {
  drafting: "TO_DRAFTING",
  validating: "TO_VALIDATING",
  ready_for_review: "TO_READY_FOR_REVIEW",
  in_review: "TO_IN_REVIEW",
  changes_requested: "TO_CHANGES_REQUESTED",
  merge_ready: "TO_MERGE_READY",
  merged: "TO_MERGED",
};

const eventToState: Record<LifecycleEvent["type"], LifecycleState> = {
  TO_DRAFTING: "drafting",
  TO_VALIDATING: "validating",
  TO_READY_FOR_REVIEW: "ready_for_review",
  TO_IN_REVIEW: "in_review",
  TO_CHANGES_REQUESTED: "changes_requested",
  TO_MERGE_READY: "merge_ready",
  TO_MERGED: "merged",
};

export const prLifecycleMachine = createMachine({
  id: "prLifecycle",
  initial: "drafting",
  states: {
    drafting: {
      on: {
        TO_DRAFTING: "drafting",
        TO_VALIDATING: "validating",
        TO_READY_FOR_REVIEW: "ready_for_review",
      },
    },
    validating: {
      on: {
        TO_DRAFTING: "drafting",
        TO_VALIDATING: "validating",
        TO_READY_FOR_REVIEW: "ready_for_review",
      },
    },
    ready_for_review: {
      on: {
        TO_IN_REVIEW: "in_review",
        TO_CHANGES_REQUESTED: "changes_requested",
        TO_MERGE_READY: "merge_ready",
        TO_DRAFTING: "drafting",
      },
    },
    in_review: {
      on: {
        TO_CHANGES_REQUESTED: "changes_requested",
        TO_MERGE_READY: "merge_ready",
        TO_DRAFTING: "drafting",
      },
    },
    changes_requested: {
      on: {
        TO_DRAFTING: "drafting",
        TO_VALIDATING: "validating",
        TO_READY_FOR_REVIEW: "ready_for_review",
        TO_IN_REVIEW: "in_review",
      },
    },
    merge_ready: {
      on: {
        TO_MERGED: "merged",
        TO_CHANGES_REQUESTED: "changes_requested",
        TO_DRAFTING: "drafting",
      },
    },
    merged: {
      on: {
        TO_MERGED: "merged",
      },
    },
  },
});

export type PrDomainEvent =
  | { type: "PR_OPENED" }
  | { type: "PR_CONVERTED_TO_DRAFT" }
  | { type: "PR_READY_FOR_REVIEW" }
  | { type: "REVIEW_REQUESTED" }
  | { type: "CHANGES_REQUESTED" }
  | { type: "REVIEW_APPROVED" }
  | { type: "PUSH_COMMIT" }
  | { type: "WORKTREE_CREATED" }
  | { type: "WORKTREE_REMOVED" }
  | { type: "BRANCH_CREATED" }
  | { type: "BRANCH_DELETED" }
  | { type: "REMOTE_BRANCH_PUBLISHED" }
  | { type: "REMOTE_CI_QUEUED" }
  | { type: "REMOTE_CI_STARTED" }
  | { type: "REMOTE_CI_PASSED" }
  | { type: "REMOTE_CI_FAILED" }
  | { type: "LOCAL_CI_STARTED" }
  | { type: "LOCAL_CI_PASSED" }
  | { type: "LOCAL_CI_FAILED" }
  | { type: "MERGEABILITY_CLEAN" }
  | { type: "MERGEABILITY_BLOCKED" }
  | { type: "MERGEABILITY_DIRTY" }
  | { type: "MERGEABILITY_UNKNOWN" }
  // Provenance axis (GH-2249, I-PROV1): the merge-guard re-verification verdict,
  // emitted by the async provenance projection (chain check-issue / audit
  // surface), never by an actor directly.
  | { type: "PROVENANCE_VERIFIED" }
  | { type: "PROVENANCE_UNSIGNED" }
  | { type: "PROVENANCE_UNCHECKED" }
  | { type: "PR_MERGED" }
  | { type: "PR_CLOSED" }
  | { type: "PR_REOPENED" }
  // Legacy aliases (kept for compatibility).
  | { type: "SUBMIT" }
  | { type: "CONVERT_TO_DRAFT" }
  | { type: "REQUEST_REVIEW" }
  | { type: "REQUEST_CHANGES" }
  | { type: "APPROVE" }
  | { type: "CI_QUEUE" }
  | { type: "CI_START" }
  | { type: "CI_PASS" }
  | { type: "CI_FAIL" }
  | { type: "MERGE" }
  | { type: "CLOSE" }
  | { type: "REOPEN" };

export const canonicalPrEventAliases: Record<string, string> = {
  SUBMIT: "PR_OPENED",
  CONVERT_TO_DRAFT: "PR_CONVERTED_TO_DRAFT",
  REQUEST_REVIEW: "REVIEW_REQUESTED",
  REQUEST_CHANGES: "CHANGES_REQUESTED",
  APPROVE: "REVIEW_APPROVED",
  CI_QUEUE: "REMOTE_CI_QUEUED",
  CI_START: "REMOTE_CI_STARTED",
  CI_PASS: "REMOTE_CI_PASSED",
  CI_FAIL: "REMOTE_CI_FAILED",
  MERGE: "PR_MERGED",
  CLOSE: "PR_CLOSED",
  REOPEN: "PR_REOPENED",
};

export type PrSystemContext = {
  lifecycle: "drafting" | "open" | "merged" | "closed";
  review: "none" | "in_review" | "approved" | "changes_requested";
  ci: "pending" | "running" | "passed" | "failed";
  mergeability: "unknown" | "clean" | "blocked" | "dirty";
  // GH-2249 (I-PROV1): merge-guard signed-derivation verdict. Optional so test
  // doubles and pre-axis snapshots stay valid; the live machine always sets it
  // (initial "unchecked" + the provenance region). Absent / "unchecked" is
  // non-blocking — only "unsigned" blocks ready_to_merge.
  provenance?: ProvenanceAxis;
};

export const initialPrSystemContext: PrSystemContext = {
  lifecycle: "drafting",
  review: "none",
  ci: "pending",
  mergeability: "unknown",
  provenance: "unchecked",
};

export function isSystemMergeReady(context: Pick<PrSystemContext, "ci" | "review" | "mergeability">): boolean {
  return (
    context.ci === "passed" &&
    context.review === "approved" &&
    context.mergeability === "clean"
  );
}

export const prSystemMachine = setup({
  types: {
    context: {} as PrSystemContext,
    events: {} as PrDomainEvent,
  },
  guards: {
    isMergeable: ({ context }) =>
      context.lifecycle === "open" && isSystemMergeReady(context),
    // Live merge gate on the workflowBackbone region's entry into
    // ready_to_merge. Reads derived context only (no ambient authority).
    mergeGate: ({ context }) => canEnterReadyToMerge(context),
  },
}).createMachine({
  id: "prSystem",
  type: "parallel",
  context: initialPrSystemContext,
  states: {
    lifecycle: {
      initial: "drafting",
      states: {
        drafting: {
          entry: assign({
            lifecycle: () => "drafting",
          }),
          on: {
            PR_OPENED: "open",
            SUBMIT: "open",
            PR_CLOSED: "closed",
            CLOSE: "closed",
          },
        },
        open: {
          entry: assign({
            lifecycle: () => "open",
          }),
          on: {
            PR_CONVERTED_TO_DRAFT: "drafting",
            CONVERT_TO_DRAFT: "drafting",
            PR_CLOSED: "closed",
            CLOSE: "closed",
            PR_MERGED: {
              target: "merged",
              guard: { type: "isMergeable" },
            },
            MERGE: {
              target: "merged",
              guard: { type: "isMergeable" },
            },
          },
        },
        merged: {
          entry: assign({
            lifecycle: () => "merged",
          }),
          type: "final",
        },
        closed: {
          entry: assign({
            lifecycle: () => "closed",
          }),
          on: {
            PR_REOPENED: "open",
            REOPEN: "open",
          },
        },
      },
    },
    review: {
      initial: "none",
      states: {
        none: {
          entry: assign({
            review: () => "none",
          }),
          on: {
            REVIEW_REQUESTED: "in_review",
            REQUEST_REVIEW: "in_review",
          },
        },
        in_review: {
          entry: assign({
            review: () => "in_review",
          }),
          on: {
            CHANGES_REQUESTED: "changes_requested",
            REQUEST_CHANGES: "changes_requested",
            REVIEW_APPROVED: "approved",
            APPROVE: "approved",
            PUSH_COMMIT: "none",
          },
        },
        changes_requested: {
          entry: assign({
            review: () => "changes_requested",
          }),
          on: {
            REVIEW_REQUESTED: "in_review",
            REQUEST_REVIEW: "in_review",
            PUSH_COMMIT: "none",
          },
        },
        approved: {
          entry: assign({
            review: () => "approved",
          }),
          on: {
            CHANGES_REQUESTED: "changes_requested",
            REQUEST_CHANGES: "changes_requested",
            PUSH_COMMIT: "none",
          },
        },
      },
    },
    ci: {
      initial: "pending",
      states: {
        pending: {
          entry: assign({
            ci: () => "pending",
          }),
          on: {
            REMOTE_CI_QUEUED: "pending",
            CI_QUEUE: "pending",
            REMOTE_CI_STARTED: "running",
            LOCAL_CI_STARTED: "running",
            CI_START: "running",
            REMOTE_CI_PASSED: "passed",
            LOCAL_CI_PASSED: "passed",
            CI_PASS: "passed",
            REMOTE_CI_FAILED: "failed",
            LOCAL_CI_FAILED: "failed",
            CI_FAIL: "failed",
          },
        },
        running: {
          entry: assign({
            ci: () => "running",
          }),
          on: {
            REMOTE_CI_PASSED: "passed",
            LOCAL_CI_PASSED: "passed",
            CI_PASS: "passed",
            REMOTE_CI_FAILED: "failed",
            LOCAL_CI_FAILED: "failed",
            CI_FAIL: "failed",
          },
        },
        passed: {
          entry: assign({
            ci: () => "passed",
          }),
          on: {
            PUSH_COMMIT: "pending",
            REMOTE_CI_FAILED: "failed",
            LOCAL_CI_FAILED: "failed",
            CI_FAIL: "failed",
          },
        },
        failed: {
          entry: assign({
            ci: () => "failed",
          }),
          on: {
            PUSH_COMMIT: "pending",
            REMOTE_CI_PASSED: "passed",
            LOCAL_CI_PASSED: "passed",
            CI_PASS: "passed",
          },
        },
      },
    },
    mergeability: {
      initial: "unknown",
      states: {
        unknown: {
          entry: assign({
            mergeability: () => "unknown",
          }),
          on: {
            MERGEABILITY_CLEAN: "clean",
            MERGEABILITY_BLOCKED: "blocked",
            MERGEABILITY_DIRTY: "dirty",
          },
        },
        clean: {
          entry: assign({
            mergeability: () => "clean",
          }),
          on: {
            MERGEABILITY_UNKNOWN: "unknown",
            PUSH_COMMIT: "unknown",
            MERGEABILITY_BLOCKED: "blocked",
            MERGEABILITY_DIRTY: "dirty",
          },
        },
        blocked: {
          entry: assign({
            mergeability: () => "blocked",
          }),
          on: {
            MERGEABILITY_UNKNOWN: "unknown",
            PUSH_COMMIT: "unknown",
            MERGEABILITY_CLEAN: "clean",
            MERGEABILITY_DIRTY: "dirty",
          },
        },
        dirty: {
          entry: assign({
            mergeability: () => "dirty",
          }),
          on: {
            MERGEABILITY_UNKNOWN: "unknown",
            PUSH_COMMIT: "unknown",
            MERGEABILITY_CLEAN: "clean",
            MERGEABILITY_BLOCKED: "blocked",
          },
        },
      },
    },
    // GH-2249 (I-PROV1): the signed-derivation axis. Driven only by the async
    // provenance projection's verdict events (PROVENANCE_*), never by an actor.
    // A new push invalidates any prior verdict (PUSH_COMMIT → unchecked), the
    // same reset discipline as ci/mergeability. "unchecked" never blocks the
    // merge gate; only "unsigned" does (see canEnterReadyToMerge).
    provenance: {
      initial: "unchecked",
      states: {
        unchecked: {
          entry: assign({
            provenance: () => "unchecked",
          }),
          on: {
            PROVENANCE_VERIFIED: "verified",
            PROVENANCE_UNSIGNED: "unsigned",
          },
        },
        verified: {
          entry: assign({
            provenance: () => "verified",
          }),
          on: {
            PUSH_COMMIT: "unchecked",
            PROVENANCE_UNSIGNED: "unsigned",
            PROVENANCE_UNCHECKED: "unchecked",
          },
        },
        unsigned: {
          entry: assign({
            provenance: () => "unsigned",
          }),
          on: {
            PUSH_COMMIT: "unchecked",
            PROVENANCE_VERIFIED: "verified",
            PROVENANCE_UNCHECKED: "unchecked",
          },
        },
      },
    },
    workflowBackbone: { ...workflowBackboneParallelRegion },
  },
});

type ConfigState = {
  on?: Partial<Record<LifecycleEvent["type"], string>>;
};

export function allowedTransitions(state: LifecycleState): LifecycleState[] {
  const configState = prLifecycleMachine.config.states![state] as ConfigState;
  const transitions = configState.on ?? {};
  return Object.keys(transitions)
    .map((event) => eventToState[event as LifecycleEvent["type"]])
    .sort();
}

export function assertValidTransition(current: LifecycleState, next: LifecycleState): void {
  if (allowedTransitions(current).includes(next)) {
    return;
  }

  const allowedText = allowedTransitions(current).join(", ");
  throw new Error(
    `invalid transition from \`${current}\` to \`${next}\`; allowed: ${allowedText}`,
  );
}

export function eventForState(state: LifecycleState): LifecycleEvent["type"] {
  return stateToEvent[state];
}

export function isReadyState(state: LifecycleState): boolean {
  return readyStates.has(state);
}

export function eventForSkill(skill: PrSkillName): SkillEventDefinition {
  return skillEventMap[skill];
}
