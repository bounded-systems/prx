// GH-1768 — shared RawStateV1 fixture builder for derive tests.

import type { BranchName, RawStateV1, Sha, WorkUnitId } from "@bounded-systems/machine-schema";

export type FixtureOverrides = Partial<{
  unitId: string;
  branchName: string | null;
  branchExistsLocal: boolean;
  branchExistsRemote: boolean;
  branchHeadShaLocal: string | null;
  branchHeadShaRemote: string | null;
  branchAhead: number;
  branchBehind: number;
  prExists: boolean;
  prState: "none" | "open" | "closed" | "merged";
  prHeadRef: string | null;
  prIsDraft: boolean | null;
  prAutoMerge: boolean;
  prNumber: number | null;
  worktreeExists: boolean;
  worktreePath: string | null;
  worktreeCheckedOutBranch: string | null;
  worktreeHeadSha: string | null;
  ciState: "none" | "queued" | "in_progress" | "passed" | "failed" | "cancelled";
  ciRequiredTotal: number;
  ciRequiredPassed: number;
  reviewDecision: "none" | "changes_requested" | "approved";
  reviewersRequested: boolean;
  unresolvedThreads: number;
  mergeability: "unknown" | "mergeable" | "blocked" | "conflicting" | "behind" | "draft";
  remoteFresh: boolean;
  observedAt: string;
}>;

export function makeRawState(overrides: FixtureOverrides = {}): RawStateV1 {
  const ts = overrides.observedAt ?? "2026-05-15T00:00:00Z";
  return {
    // GH-2098: fixture overrides stay plain `string` for caller ergonomics;
    // brand at the single construction point (the schema brands on `.parse()`).
    unitId: (overrides.unitId ?? "GH-1768") as WorkUnitId,
    artifacts: {
      ticket: {
        exists: true,
        id: overrides.unitId ?? "GH-1768",
        system: "bd",
        url: null,
      },
      worktree: {
        exists: overrides.worktreeExists ?? false,
        path: overrides.worktreePath ?? null,
        checkedOutBranch: (overrides.worktreeCheckedOutBranch ?? null) as BranchName | null,
        headSha: (overrides.worktreeHeadSha ?? null) as Sha | null,
      },
      branch: {
        name: (overrides.branchName === undefined
          ? null
          : overrides.branchName) as BranchName | null,
        existsLocal: overrides.branchExistsLocal ?? false,
        existsRemote: overrides.branchExistsRemote ?? false,
        ahead: overrides.branchAhead ?? 0,
        behind: overrides.branchBehind ?? 0,
        headShaLocal: (overrides.branchHeadShaLocal ?? null) as Sha | null,
        headShaRemote: (overrides.branchHeadShaRemote ?? null) as Sha | null,
      },
      pr: {
        exists: overrides.prExists ?? false,
        number: overrides.prNumber ?? null,
        state: overrides.prState ?? "none",
        isDraft: overrides.prIsDraft ?? null,
        headRef: (overrides.prHeadRef ?? null) as BranchName | null,
        baseRef: null,
        url: null,
        autoMergeRequest: overrides.prAutoMerge
          ? { enabledBy: "bot", mergeMethod: "SQUASH" }
          : null,
      },
    },
    signals: {
      review: {
        decision: overrides.reviewDecision ?? "none",
        reviewersRequested: overrides.reviewersRequested ?? false,
        unresolvedThreads: overrides.unresolvedThreads ?? 0,
      },
      ci: {
        state: overrides.ciState ?? "none",
        requiredTotal: overrides.ciRequiredTotal ?? 0,
        requiredPassed: overrides.ciRequiredPassed ?? 0,
        failing: [],
      },
      mergeability: {
        state: overrides.mergeability ?? "unknown",
        blockedReasons: [],
      },
    },
    sync: {
      remoteFresh: overrides.remoteFresh ?? false,
      ticketLinkedToPR: null,
    },
    meta: {
      observedAt: ts,
      sources: {
        git: ts,
        gh: ts,
        ticketSystem: ts,
      },
    },
  };
}
