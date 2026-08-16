import { describe, expect, test } from "bun:test";

import {
  buildActionSnapshot,
  nextAction,
  resolveActions,
  type ActionSnapshot,
} from "../../src/pr-state/actions.ts";
import type { CommandRunner } from "../../src/pr-state/github.ts";
// GH-2098: brand the plain-string `rawState` fixture as validated raw state.
import type { RawStateV1 } from "@bounded-systems/machine-schema";

function baseSnapshot(): ActionSnapshot {
  return {
    repoRoot: "/repo",
    branch: "GH-1001-feature",
    contractExists: true,
    operation: "none",
    remoteFreshness: "fresh",
    local: {
      staged: 0,
      unstaged: 0,
      untracked: 0,
      ignored: 0,
      conflicts: 0,
    },
    pr: {
      exists: true,
      number: 10,
      title: "PR title",
      url: "https://example.com/10",
      draft: false,
      checks: "green",
      review: "approved",
      approvals: 1,
      mergeable: "mergeable",
    },
    system: {
      lifecycle: "open",
      review: "approved",
      ci: "passed",
      mergeability: "clean",
    },
    mergeReady: true,
    phase: "ready_to_merge",
    currentUnit: null,
    rawState: {
      unitId: "GH-1001",
      artifacts: {
        ticket: {
          exists: true,
          id: "GH-1001",
          system: "other",
          url: null,
        },
        worktree: {
          exists: true,
          path: "/repo",
          checkedOutBranch: "GH-1001-feature",
          headSha: "abc123",
        },
        branch: {
          name: "GH-1001-feature",
          existsLocal: true,
          existsRemote: true,
          ahead: 0,
          behind: 0,
          headShaLocal: "abc123",
          headShaRemote: "abc123",
        },
        pr: {
          exists: true,
          number: 10,
          state: "open",
          isDraft: false,
          headRef: "GH-1001-feature",
          baseRef: "main",
          url: "https://example.com/10",
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
        observedAt: "2026-03-19T00:00:00Z",
        sources: {
          git: "2026-03-19T00:00:00Z",
          gh: "2026-03-19T00:00:00Z",
          ticketSystem: "2026-03-19T00:00:00Z",
        },
      },
    } as unknown as RawStateV1,
    invariants: {
      valid: true,
      findings: [],
    },
  };
}

describe("actions", () => {
  test("prioritizes contract initialization when missing", () => {
    const snapshot = baseSnapshot();
    snapshot.contractExists = false;
    snapshot.pr.exists = false;
    snapshot.pr.number = null;

    const actions = resolveActions(snapshot);
    expect(actions[0]).toMatchObject({
      id: "contract.init",
      command: "prx contract init",
      enabled: true,
    });
  });

  test("suggests merge when gate is satisfied", () => {
    const actions = resolveActions(baseSnapshot());
    expect(actions[0]).toMatchObject({
      id: "contract.init",
      enabled: false,
      disabledReason: "PR contract already initialized",
    });
    expect(actions.find((action) => action.enabled)).toMatchObject({
      id: "pr.merge",
    });
  });

  test("suggests validate when CI is pending", () => {
    const snapshot = baseSnapshot();
    snapshot.system.ci = "pending";
    snapshot.mergeReady = false;

    const actions = resolveActions(snapshot);
    expect(actions.find((action) => action.enabled)).toMatchObject({
      id: "pr.validate",
    });
  });

  test("returns disabled actions with reasons when guards fail", () => {
    const snapshot = baseSnapshot();
    snapshot.pr.exists = false;
    snapshot.pr.number = null;
    snapshot.pr.url = null;
    snapshot.system.review = "none";
    snapshot.mergeReady = false;

    const actions = resolveActions(snapshot);
    expect(actions).toHaveLength(14);
    expect(actions.find((action) => action.id === "pr.merge")).toMatchObject({
      id: "pr.merge",
      enabled: false,
      command: "gh pr merge <pr-number> --squash --delete-branch",
      disabledReason: "pull request does not exist",
    });
    expect(actions.find((action) => action.id === "pr.merge")?.reason).toBeUndefined();
    expect(actions.find((action) => action.id === "pr.mark_ready")).toMatchObject({
      id: "pr.mark_ready",
      enabled: false,
      command: "gh pr ready <pr-number>",
      disabledReason: "pull request does not exist",
    });
    expect(actions.find((action) => action.id === "pr.request_review")).toMatchObject({
      id: "pr.request_review",
      enabled: false,
      disabledReason: "pull request does not exist",
    });
  });

  test("keeps disabled actions ahead of the first enabled action in catalog order", () => {
    const snapshot = baseSnapshot();
    const actions = resolveActions(snapshot);
    expect(actions[0]).toMatchObject({
      id: "contract.init",
      enabled: false,
    });
    expect(actions.find((action) => action.enabled)).toMatchObject({
      id: "pr.merge",
    });
  });

  test("treats detached mainx as survey context instead of branch workflow", () => {
    const runner: CommandRunner = (cmd, options) => {
      if (cmd.join(" ") === "git -C /repo/mainx rev-parse --show-toplevel") {
        return { stdout: "/repo/mainx\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "git -C /repo/mainx status --porcelain=v1 -b") {
        return { stdout: "## HEAD (no branch)\n", stderr: "", status: 0 };
      }
      if (
        cmd.join(" ") === "git -C /repo/mainx rev-parse --git-path MERGE_HEAD" ||
        cmd.join(" ") === "git -C /repo/mainx rev-parse --git-path rebase-apply" ||
        cmd.join(" ") === "git -C /repo/mainx rev-parse --git-path rebase-merge" ||
        cmd.join(" ") === "git -C /repo/mainx rev-parse --git-path CHERRY_PICK_HEAD"
      ) {
        return { stdout: "", stderr: "", status: 1 };
      }
      if (cmd.join(" ") === "git -C /repo/mainx worktree list --porcelain") {
        return {
          stdout: "worktree /repo/mainx\nHEAD ddd333\ndetached\n\n",
          stderr: "",
          status: 0,
        };
      }
      if (cmd[0] === "gh" && cmd[1] === "repo") {
        return { stdout: "owner/repo\n", stderr: "", status: 0 };
      }
      if (
        cmd.join(" ") ===
        "gh pr list --state open --json number,headRefName,title,isDraft,url,reviewDecision,statusCheckRollup,mergeable,reviews -R owner/repo"
      ) {
        return { stdout: "[]", stderr: "", status: 0 };
      }
      if (
        cmd.join(" ") ===
        "gh pr view --json number,state,isDraft,title,url,headRefName,reviewDecision,statusCheckRollup,mergeable,reviews"
      ) {
        return { stdout: "", stderr: "no pull requests found", status: 1 };
      }
      if (cmd.join(" ") === "git -C /repo/mainx fetch --dry-run origin") {
        return { stdout: "", stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const snapshot = buildActionSnapshot("/repo/mainx", runner);
    expect(snapshot.branch).toBeNull();
    expect(snapshot.currentUnit).toMatchObject({
      branch: "MAIN",
      worktree_path: "/repo/mainx",
      column: "pushed",
    });
    expect(snapshot.phase).toBe("pushed");
    expect(snapshot.rawState.artifacts.worktree).toMatchObject({
      exists: true,
      checkedOutBranch: "MAIN",
    });
    expect(snapshot.rawState.artifacts.branch).toMatchObject({
      name: "MAIN",
      existsLocal: true,
      existsRemote: true,
    });

    const plan = nextAction("/repo/mainx", runner);
    expect(plan.next).toMatchObject({
      id: "survey.overview",
      command: "prx overview",
      actor: "prx",
      surface: "tool",
    });
    expect(plan.actions.find((action) => action.id === "pr.next")).toMatchObject({
      enabled: false,
      disabledReason: "branch context not available",
    });
    expect(plan.actions.find((action) => action.id === "contract.init")).toMatchObject({
      enabled: false,
      disabledReason: "branch context not available",
    });
    expect(plan.actions.find((action) => action.id === "pr.open")).toMatchObject({
      enabled: false,
      disabledReason: "branch context not available",
    });
  });

  test("pr.next is disabled when branch exists but contract does not", () => {
    const snapshot = baseSnapshot();
    snapshot.contractExists = false;
    snapshot.pr.exists = false;
    snapshot.pr.number = null;

    const plan = { actions: resolveActions(snapshot) };
    const pickedNext = plan.actions.find((action) => action.enabled) ?? null;
    expect(pickedNext).toMatchObject({ id: "contract.init" });
    expect(plan.actions.find((action) => action.id === "pr.next")).toMatchObject({
      enabled: false,
      disabledReason: "PR contract not initialized",
    });
    expect(plan.actions.find((action) => action.id === "survey.overview")).toMatchObject({
      enabled: true,
    });
  });

  test("pr.next remains enabled on branch with contract when nothing higher fires", () => {
    const snapshot = baseSnapshot();
    snapshot.mergeReady = false;
    snapshot.rawState.signals.mergeability.state = "mergeable";

    const actions = resolveActions(snapshot);
    const firstEnabled = actions.find((action) => action.enabled);
    expect(firstEnabled).toMatchObject({ id: "pr.next" });
  });

  test("git.refresh fires when mergeability state is behind", () => {
    const snapshot = baseSnapshot();
    snapshot.rawState.signals.mergeability.state = "behind";
    snapshot.rawState.signals.mergeability.blockedReasons = [];
    snapshot.mergeReady = false;

    const actions = resolveActions(snapshot);
    const refresh = actions.find((action) => action.id === "git.refresh");
    expect(refresh).toMatchObject({
      id: "git.refresh",
      actor: "git",
      surface: "tool",
      label: "Rebase branch onto origin/main",
      priority: 95,
      enabled: true,
      command: "prx worktree refresh",
      reason: "Branch is behind origin/main and needs rebase",
    });
  });

  test("git.refresh disabled when mergeability is mergeable", () => {
    const snapshot = baseSnapshot();
    snapshot.rawState.signals.mergeability.state = "mergeable";

    const actions = resolveActions(snapshot);
    const refresh = actions.find((action) => action.id === "git.refresh");
    expect(refresh).toMatchObject({
      id: "git.refresh",
      enabled: false,
      disabledReason: "branch is up to date with base",
    });
  });

  test("git.refresh disabled when no branch context", () => {
    const snapshot = baseSnapshot();
    snapshot.branch = null;
    snapshot.rawState.signals.mergeability.state = "behind";

    const actions = resolveActions(snapshot);
    const refresh = actions.find((action) => action.id === "git.refresh");
    expect(refresh).toMatchObject({
      id: "git.refresh",
      enabled: false,
      disabledReason: "branch context not available",
    });
  });

  test("git.refresh priority is between pr.request_review (90) and git.fetch (100)", () => {
    const snapshot = baseSnapshot();
    const actions = resolveActions(snapshot);
    const refresh = actions.find((action) => action.id === "git.refresh");
    const requestReview = actions.find((action) => action.id === "pr.request_review");
    const fetch = actions.find((action) => action.id === "git.fetch");
    expect(refresh!.priority).toBe(95);
    expect(refresh!.priority).toBeGreaterThan(requestReview!.priority);
    expect(refresh!.priority).toBeLessThan(fetch!.priority);
  });
});
