import { describe, expect, test } from "bun:test";
import { createActor } from "xstate";

import { canEnterReadyToMerge, workflowMachine } from "../../../src/machine/machines/workflow.ts";
import { prSystemMachine } from "../../../src/machine/machines/pr.ts";

// The live merge gate, wired into the workflowBackbone region of prSystemMachine
// (docs/anchored-chain/merge-gate-production.md). Entry into `ready_to_merge`
// is guarded: it fires only when review evidence is approved AND test/CI
// evidence passed. The guard reads derived context, never the triggering
// event — so an actor cannot force the transition by sending the event alone
// (no ambient authority).

function backbonePhase(actor: ReturnType<typeof createActor>): string {
  const value = actor.getSnapshot().value as Record<string, unknown>;
  return String(value.workflowBackbone);
}

function lifecyclePhase(actor: ReturnType<typeof createActor>): string {
  const value = actor.getSnapshot().value as Record<string, unknown>;
  return String(value.lifecycle);
}

function driveToInReview(actor: ReturnType<typeof createActor>): void {
  actor.send({ type: "WORKTREE_CREATED" });
  actor.send({ type: "BRANCH_CREATED" });
  actor.send({ type: "PUSH_COMMIT" });
  actor.send({ type: "REMOTE_BRANCH_PUBLISHED" });
  actor.send({ type: "PR_OPENED" });
  actor.send({ type: "REVIEW_REQUESTED" });
}

describe("canEnterReadyToMerge (the gate predicate)", () => {
  test("true only when review approved AND ci passed", () => {
    expect(canEnterReadyToMerge({ review: "approved", ci: "passed" })).toBe(true);
    expect(canEnterReadyToMerge({ review: "approved", ci: "pending" })).toBe(false);
    expect(canEnterReadyToMerge({ review: "in_review", ci: "passed" })).toBe(false);
    expect(canEnterReadyToMerge({ review: "none", ci: "pending" })).toBe(false);
  });

  // GH-2249 (I-PROV1): the provenance axis only blocks on "unsigned"; absent /
  // "unchecked" / "verified" never tighten an otherwise-ready gate.
  test("provenance axis: only 'unsigned' blocks an otherwise-ready gate", () => {
    const ready = { review: "approved", ci: "passed" } as const;
    expect(canEnterReadyToMerge(ready)).toBe(true); // absent ⇒ non-blocking
    expect(canEnterReadyToMerge({ ...ready, provenance: "unchecked" })).toBe(true);
    expect(canEnterReadyToMerge({ ...ready, provenance: "verified" })).toBe(true);
    expect(canEnterReadyToMerge({ ...ready, provenance: "unsigned" })).toBe(false);
  });

  test("provenance never licenses a gate review+ci have not already opened", () => {
    expect(
      canEnterReadyToMerge({ review: "in_review", ci: "passed", provenance: "verified" }),
    ).toBe(false);
    expect(
      canEnterReadyToMerge({ review: "approved", ci: "pending", provenance: "verified" }),
    ).toBe(false);
  });
});

describe("merge gate is wired live into the workflowBackbone", () => {
  test("the in_review→ready_to_merge transitions are guarded (not bare strings)", () => {
    const states = workflowMachine.config.states as Record<
      string,
      { on?: Record<string, unknown> }
    >;
    for (const event of ["REVIEW_APPROVED", "APPROVE", "MERGEABILITY_CLEAN"]) {
      const t = states.in_review?.on?.[event];
      expect(t).toMatchObject({ target: "ready_to_merge", guard: { type: "mergeGate" } });
    }
  });

  test("REFUSES ready_to_merge when the event fires without review+ci (no ambient authority)", () => {
    const actor = createActor(prSystemMachine);
    actor.start();
    driveToInReview(actor);
    expect(backbonePhase(actor)).toBe("in_review");

    // An actor fires the transition event directly — but lacks the evidence.
    actor.send({ type: "MERGEABILITY_CLEAN" });
    expect(backbonePhase(actor)).toBe("in_review"); // gate held

    // Even approval alone (tests not yet passed) does not license merge.
    actor.send({ type: "REVIEW_APPROVED" });
    actor.send({ type: "MERGEABILITY_CLEAN" });
    expect(backbonePhase(actor)).toBe("in_review"); // still held: ci not passed
  });

  test("LICENSES ready_to_merge once review is approved AND ci passed", () => {
    const actor = createActor(prSystemMachine);
    actor.start();
    driveToInReview(actor);

    actor.send({ type: "CI_PASS" }); // ci → passed (backbone stays in_review)
    actor.send({ type: "REVIEW_APPROVED" }); // review → approved
    expect(backbonePhase(actor)).toBe("in_review"); // not yet re-evaluated

    actor.send({ type: "MERGEABILITY_CLEAN" }); // gate now satisfied
    expect(backbonePhase(actor)).toBe("ready_to_merge");
  });
});

// GH-2249 (I-PROV1): the provenance axis, driven by the async projection's
// verdict events (PROVENANCE_*), gates ready_to_merge alongside review+ci.
function provenanceAxis(actor: ReturnType<typeof createActor>): string {
  const value = actor.getSnapshot().value as Record<string, unknown>;
  return String(value.provenance);
}

describe("merge gate — provenance axis (I-PROV1)", () => {
  test("REFUSES ready_to_merge when provenance is unsigned, even with review+ci", () => {
    const actor = createActor(prSystemMachine);
    actor.start();
    driveToInReview(actor);
    actor.send({ type: "CI_PASS" });
    actor.send({ type: "REVIEW_APPROVED" });

    actor.send({ type: "PROVENANCE_UNSIGNED" }); // enforcement found a bad/absent sig
    expect(provenanceAxis(actor)).toBe("unsigned");

    actor.send({ type: "MERGEABILITY_CLEAN" }); // would otherwise license
    expect(backbonePhase(actor)).toBe("in_review"); // gate held by provenance
  });

  test("LICENSES ready_to_merge once provenance verifies (review+ci already met)", () => {
    const actor = createActor(prSystemMachine);
    actor.start();
    driveToInReview(actor);
    actor.send({ type: "CI_PASS" });
    actor.send({ type: "REVIEW_APPROVED" });
    actor.send({ type: "PROVENANCE_UNSIGNED" });
    actor.send({ type: "MERGEABILITY_CLEAN" });
    expect(backbonePhase(actor)).toBe("in_review"); // still held

    actor.send({ type: "PROVENANCE_VERIFIED" }); // re-verification now passes
    expect(provenanceAxis(actor)).toBe("verified");
    actor.send({ type: "MERGEABILITY_CLEAN" });
    expect(backbonePhase(actor)).toBe("ready_to_merge");
  });

  test("unchecked (enforcement off / not computed) does not block — unchanged", () => {
    const actor = createActor(prSystemMachine);
    actor.start();
    driveToInReview(actor);
    expect(provenanceAxis(actor)).toBe("unchecked"); // initial axis
    actor.send({ type: "CI_PASS" });
    actor.send({ type: "REVIEW_APPROVED" });
    actor.send({ type: "MERGEABILITY_CLEAN" });
    expect(backbonePhase(actor)).toBe("ready_to_merge");
  });

  test("a new push invalidates a prior verdict (PROVENANCE → unchecked)", () => {
    const actor = createActor(prSystemMachine);
    actor.start();
    driveToInReview(actor);
    actor.send({ type: "PROVENANCE_VERIFIED" });
    expect(provenanceAxis(actor)).toBe("verified");
    actor.send({ type: "PUSH_COMMIT" }); // new head ⇒ prior verification stale
    expect(provenanceAxis(actor)).toBe("unchecked");
  });
});

// The merge ACT itself (lifecycle open → merged on PR_MERGED/MERGE) is guarded
// by `isMergeable` (ci passed + review approved + mergeability clean) — strictly
// stronger than the ready_to_merge phase gate (it adds mergeability=clean). The
// config + predicate are covered elsewhere; this proves the guard actually
// BLOCKS the transition at runtime (no ambient authority for the merge).
describe("merge act (PR_MERGED) — no ambient authority", () => {
  test("REFUSES merge when the event fires without merge-readiness", () => {
    const actor = createActor(prSystemMachine);
    actor.start();
    actor.send({ type: "PR_OPENED" }); // lifecycle → open
    expect(lifecyclePhase(actor)).toBe("open");

    // An actor fires MERGE/PR_MERGED directly, but ci/review/mergeability are
    // not satisfied — the guard reads context, not the event.
    actor.send({ type: "MERGE" });
    expect(lifecyclePhase(actor)).toBe("open");
    actor.send({ type: "PR_MERGED" });
    expect(lifecyclePhase(actor)).toBe("open");
  });

  test("ALLOWS merge once ci passed + review approved + mergeability clean", () => {
    const actor = createActor(prSystemMachine);
    actor.start();
    actor.send({ type: "PR_OPENED" }); // lifecycle → open
    actor.send({ type: "REVIEW_REQUESTED" }); // review → in_review
    actor.send({ type: "REVIEW_APPROVED" }); // review → approved
    actor.send({ type: "CI_PASS" }); // ci → passed
    actor.send({ type: "MERGEABILITY_CLEAN" }); // mergeability → clean
    expect(lifecyclePhase(actor)).toBe("open"); // still open until merge fires

    actor.send({ type: "PR_MERGED" });
    expect(lifecyclePhase(actor)).toBe("merged");
  });
});
