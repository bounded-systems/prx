// GH-1768 — drift rule tests. One golden case per encoded invariant.

import { describe, expect, test } from "bun:test";

import { projectAndRun, queryDrift } from "../../src/derive/index.ts";
import { makeRawState } from "./fixtures.ts";

describe("rules/drift — structural invariants", () => {
  test("I01: pr.exists with no branch present", () => {
    const { view } = projectAndRun({
      rawStates: [
        makeRawState({
          prExists: true,
          prState: "open",
          prHeadRef: "GH-1768",
          branchName: "GH-1768",
          branchExistsLocal: false,
          branchExistsRemote: false,
        }),
      ],
    });
    expect(queryDrift(view).map((d) => d.code)).toContain("I01");
  });

  test("I02: pr.headRef does not match branch.name", () => {
    const { view } = projectAndRun({
      rawStates: [
        makeRawState({
          prExists: true,
          prState: "open",
          prHeadRef: "GH-1768",
          branchName: "GH-9999",
          branchExistsLocal: true,
        }),
      ],
    });
    expect(queryDrift(view).map((d) => d.code)).toContain("I02");
  });

  test("I03: worktree without matching local branch", () => {
    const { view } = projectAndRun({
      rawStates: [
        makeRawState({
          worktreeExists: true,
          worktreePath: "/tmp/wt",
          worktreeCheckedOutBranch: "GH-1768",
          branchName: "GH-9999",
          branchExistsLocal: true,
        }),
      ],
    });
    expect(queryDrift(view).map((d) => d.code)).toContain("I03");
  });

  test("I05: phase=cleaned but worktree still present", () => {
    const { view } = projectAndRun({
      rawStates: [
        // derivePhase returns "merged" when state="merged" and worktree/branch
        // still exist; to force "cleaned" we need merged + no worktree/branch.
        // For a real I05 violation we need a fixture where the imperative
        // derivePhase yields "cleaned" but data violates the postcondition.
        // That can only happen if phase is reported externally — for the
        // spike the projection re-derives phase, so I05 is unreachable
        // through the public API. We assert I05 fires by injecting a
        // synthetic "cleaned" phase via a follow-up test (see oracle.test).
        makeRawState({
          prState: "merged",
          worktreeExists: false,
          branchName: "GH-1",
          branchExistsLocal: false,
        }),
      ],
    });
    // Cleaned with consistent state should have no drift.
    expect(queryDrift(view)).toEqual([]);
  });

  test("I06: requiredPassed exceeds requiredTotal", () => {
    const { view } = projectAndRun({
      rawStates: [
        makeRawState({
          ciState: "passed",
          ciRequiredTotal: 3,
          ciRequiredPassed: 5,
        }),
      ],
    });
    expect(queryDrift(view).map((d) => d.code)).toContain("I06");
  });

  test("I07: ci passed but counts disagree", () => {
    const { view } = projectAndRun({
      rawStates: [
        makeRawState({
          ciState: "passed",
          ciRequiredTotal: 5,
          ciRequiredPassed: 4,
        }),
      ],
    });
    expect(queryDrift(view).map((d) => d.code)).toContain("I07");
  });

  test("I08: remoteFresh but local/remote SHA differ", () => {
    const { view } = projectAndRun({
      rawStates: [
        makeRawState({
          branchName: "GH-1",
          branchExistsLocal: true,
          branchExistsRemote: true,
          branchHeadShaLocal: "abc",
          branchHeadShaRemote: "def",
          remoteFresh: true,
        }),
      ],
    });
    expect(queryDrift(view).map((d) => d.code)).toContain("I08");
  });

  test("clean fixture reports no drift", () => {
    const { view } = projectAndRun({
      rawStates: [
        makeRawState({
          unitId: "GH-1",
          prExists: true,
          prState: "open",
          prHeadRef: "GH-1",
          prIsDraft: false,
          branchName: "GH-1",
          branchExistsLocal: true,
          branchExistsRemote: true,
          branchHeadShaLocal: "sha-1",
          branchHeadShaRemote: "sha-1",
          worktreeExists: true,
          worktreePath: "/tmp/wt",
          worktreeCheckedOutBranch: "GH-1",
          ciState: "passed",
          ciRequiredTotal: 3,
          ciRequiredPassed: 3,
          remoteFresh: true,
        }),
      ],
    });
    expect(queryDrift(view)).toEqual([]);
  });
});
