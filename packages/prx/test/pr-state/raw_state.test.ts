import { describe, expect, test } from "bun:test";

import {
  assertInvariants,
  derivePhase,
  type BranchName,
  type RawStateV1,
  type Sha,
  type WorkflowPhase,
  type WorkUnitId,
} from "@bounded-systems/machine-schema";

const now = "2026-03-19T00:00:00Z";

function baseRaw(): RawStateV1 {
  return {
    unitId: "GH-1001" as WorkUnitId,
    artifacts: {
      ticket: { exists: true, id: "GH-1001", system: "other", url: null },
      worktree: {
        exists: true,
        path: "/repo",
        checkedOutBranch: "feature-x" as BranchName,
        headSha: "abc" as Sha,
      },
      branch: {
        name: "feature-x" as BranchName,
        existsLocal: true,
        existsRemote: true,
        ahead: 0,
        behind: 0,
        headShaLocal: "abc" as Sha,
        headShaRemote: "abc" as Sha,
      },
      pr: {
        exists: true,
        number: 12,
        state: "open",
        isDraft: false,
        headRef: "feature-x" as BranchName,
        baseRef: "main" as BranchName,
        url: "https://example.com/12",
        autoMergeRequest: null,
      },
    },
    signals: {
      review: {
        decision: "approved",
        reviewersRequested: true,
        unresolvedThreads: 0,
      },
      ci: {
        state: "passed",
        requiredTotal: 1,
        requiredPassed: 1,
        failing: [],
      },
      mergeability: {
        state: "mergeable",
        blockedReasons: [],
      },
    },
    sync: {
      remoteFresh: true,
      ticketLinkedToPR: true,
    },
    meta: {
      observedAt: now,
      sources: {
        git: now,
        gh: now,
        ticketSystem: now,
      },
    },
  };
}

function expectPhase(name: string, mutate: (raw: RawStateV1) => void, phase: WorkflowPhase) {
  test(name, () => {
    const raw = baseRaw();
    mutate(raw);
    expect(derivePhase(raw)).toBe(phase);
  });
}

describe("raw_state derivePhase fixtures", () => {
  expectPhase(
    "T01 no worktree -> no_worktree",
    (raw) => {
      raw.artifacts.pr.exists = false;
      raw.artifacts.pr.state = "none";
      raw.artifacts.worktree.exists = false;
      raw.artifacts.worktree.path = null;
    },
    "no_worktree",
  );

  expectPhase(
    "T02 worktree exists, no local branch -> worktree_created",
    (raw) => {
      raw.artifacts.pr.exists = false;
      raw.artifacts.pr.state = "none";
      raw.artifacts.branch.existsLocal = false;
      raw.artifacts.branch.name = null;
      raw.artifacts.worktree.exists = true;
      raw.artifacts.worktree.checkedOutBranch = "feature-x" as BranchName;
    },
    "worktree_created",
  );

  expectPhase(
    "T03 local branch only, zero ahead, no PR -> branch_created",
    (raw) => {
      raw.artifacts.pr.exists = false;
      raw.artifacts.pr.state = "none";
      raw.artifacts.branch.existsRemote = false;
      raw.artifacts.branch.ahead = 0;
    },
    "branch_created",
  );

  expectPhase(
    "T04 local branch with unpushed commits, no PR -> committing",
    (raw) => {
      raw.artifacts.pr.exists = false;
      raw.artifacts.pr.state = "none";
      raw.artifacts.branch.existsRemote = false;
      raw.artifacts.branch.ahead = 2;
    },
    "committing",
  );

  expectPhase(
    "T05 remote branch exists, no PR -> pushed",
    (raw) => {
      raw.artifacts.pr.exists = false;
      raw.artifacts.pr.state = "none";
      raw.artifacts.branch.existsRemote = true;
    },
    "pushed",
  );

  expectPhase(
    "T06 open draft PR -> draft",
    (raw) => {
      raw.artifacts.pr.isDraft = true;
      raw.signals.mergeability.state = "draft";
    },
    "draft",
  );

  expectPhase(
    "T07 open PR, changes requested -> changes_requested",
    (raw) => {
      raw.signals.review.decision = "changes_requested";
    },
    "changes_requested",
  );

  expectPhase(
    "T08 open PR, CI running -> waiting_on_ci",
    (raw) => {
      raw.signals.ci.state = "in_progress";
    },
    "waiting_on_ci",
  );

  expectPhase(
    "T09 open PR, CI failed -> blocked",
    (raw) => {
      raw.signals.ci.state = "failed";
    },
    "blocked",
  );

  expectPhase(
    "T10 open PR, merge conflict -> blocked",
    (raw) => {
      raw.signals.mergeability.state = "conflicting";
    },
    "blocked",
  );

  expectPhase(
    "T11 open PR, approved+passed+mergeable+fresh -> ready_to_merge",
    () => {},
    "ready_to_merge",
  );

  expectPhase(
    "T12 open PR, no reviewers requested -> ready_for_review",
    (raw) => {
      raw.signals.review.decision = "none";
      raw.signals.review.reviewersRequested = false;
    },
    "ready_for_review",
  );

  expectPhase(
    "T13 open PR, reviewers requested -> in_review",
    (raw) => {
      raw.signals.review.decision = "none";
      raw.signals.review.reviewersRequested = true;
    },
    "in_review",
  );

  expectPhase(
    "T14 merged PR with worktree present -> merged",
    (raw) => {
      raw.artifacts.pr.state = "merged";
      raw.artifacts.worktree.exists = true;
      raw.artifacts.branch.existsLocal = true;
    },
    "merged",
  );

  expectPhase(
    "T15 merged PR + no worktree + no local branch -> cleaned",
    (raw) => {
      raw.artifacts.pr.state = "merged";
      raw.artifacts.worktree.exists = false;
      raw.artifacts.worktree.path = null;
      raw.artifacts.branch.existsLocal = false;
    },
    "cleaned",
  );

  expectPhase(
    "T16 closed unmerged PR -> closed",
    (raw) => {
      raw.artifacts.pr.state = "closed";
    },
    "closed",
  );

  // GH-885: when GitHub holds a registered automerge request, the PR moves
  // from `ready_to_merge` (passive — operator must click) into
  // `automerge_enabled` (active — GitHub will merge when the gate clears).
  expectPhase(
    "T17 ready-to-merge with autoMergeRequest -> automerge_enabled",
    (raw) => {
      raw.artifacts.pr.autoMergeRequest = {
        enabledBy: "operator",
        mergeMethod: "SQUASH",
      };
    },
    "automerge_enabled",
  );
});

describe("raw_state invariant matrix", () => {
  test("I01..I08 pass on valid baseline", () => {
    const raw = baseRaw();
    const phase = derivePhase(raw);
    const report = assertInvariants(raw, phase);
    expect(report.valid).toBeTrue();
    expect(report.findings).toHaveLength(0);
  });

  test("I01 fails when PR exists without any branch", () => {
    const raw = baseRaw();
    raw.artifacts.branch.existsLocal = false;
    raw.artifacts.branch.existsRemote = false;
    const report = assertInvariants(raw, derivePhase(raw));
    expect(report.findings.some((f) => f.id === "I01")).toBeTrue();
  });

  test("I02 fails when PR headRef mismatches branch.name", () => {
    const raw = baseRaw();
    raw.artifacts.pr.headRef = "feature-y" as BranchName;
    const report = assertInvariants(raw, derivePhase(raw));
    expect(report.findings.some((f) => f.id === "I02")).toBeTrue();
  });

  test("I03 fails when worktree branch mismatches local branch", () => {
    const raw = baseRaw();
    raw.artifacts.worktree.checkedOutBranch = "feature-y" as BranchName;
    const report = assertInvariants(raw, derivePhase(raw));
    expect(report.findings.some((f) => f.id === "I03")).toBeTrue();
  });

  test("I04 fails when ready_to_merge lacks remote freshness", () => {
    const raw = baseRaw();
    raw.sync.remoteFresh = false;
    const report = assertInvariants(raw, "ready_to_merge");
    expect(report.findings.some((f) => f.id === "I04")).toBeTrue();
  });

  test("I05 fails when cleaned still has local branch", () => {
    const raw = baseRaw();
    raw.artifacts.pr.state = "merged";
    const report = assertInvariants(raw, "cleaned");
    expect(report.findings.some((f) => f.id === "I05")).toBeTrue();
  });

  test("I06 fails when requiredPassed > requiredTotal", () => {
    const raw = baseRaw();
    raw.signals.ci.requiredPassed = 2;
    raw.signals.ci.requiredTotal = 1;
    const report = assertInvariants(raw, derivePhase(raw));
    expect(report.findings.some((f) => f.id === "I06")).toBeTrue();
  });

  test("I07 fails when ci passed but totals are not equal", () => {
    const raw = baseRaw();
    raw.signals.ci.state = "passed";
    raw.signals.ci.requiredPassed = 0;
    raw.signals.ci.requiredTotal = 1;
    const report = assertInvariants(raw, derivePhase(raw));
    expect(report.findings.some((f) => f.id === "I07")).toBeTrue();
  });

  test("I08 fails when remoteFresh with differing SHAs", () => {
    const raw = baseRaw();
    raw.sync.remoteFresh = true;
    raw.artifacts.branch.headShaRemote = "def" as Sha;
    const report = assertInvariants(raw, derivePhase(raw));
    expect(report.findings.some((f) => f.id === "I08")).toBeTrue();
  });

  // GH-885 / I09: phase=automerge_enabled requires both the I04 gate and
  // a present autoMergeRequest payload.
  test("I09 passes when automerge_enabled with full I04 + autoMergeRequest", () => {
    const raw = baseRaw();
    raw.artifacts.pr.autoMergeRequest = { enabledBy: "operator", mergeMethod: "SQUASH" };
    const phase = derivePhase(raw);
    expect(phase).toBe("automerge_enabled");
    const report = assertInvariants(raw, phase);
    expect(report.valid).toBeTrue();
  });

  test("I09 fails when claimed automerge_enabled without autoMergeRequest", () => {
    const raw = baseRaw();
    // No autoMergeRequest set — but caller asserts the phase anyway.
    const report = assertInvariants(raw, "automerge_enabled");
    expect(report.findings.some((f) => f.id === "I09")).toBeTrue();
  });

  test("I09 fails when claimed automerge_enabled but I04 conditions are missing", () => {
    const raw = baseRaw();
    raw.artifacts.pr.autoMergeRequest = { enabledBy: "operator", mergeMethod: "SQUASH" };
    raw.signals.ci.state = "failed";
    raw.signals.ci.requiredPassed = 0;
    const report = assertInvariants(raw, "automerge_enabled");
    expect(report.findings.some((f) => f.id === "I09")).toBeTrue();
  });
});
