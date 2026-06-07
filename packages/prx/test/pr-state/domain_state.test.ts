import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildDomainState,
  defaultDomainStatePath,
  loadDomainState,
  refreshDomainStateFromGitHub,
  writeDomainState,
} from "../../src/pr-state/domain_state.ts";
import { writeContract } from "../../src/pr-state/contract.ts";
import { createTaskContract, defaultTaskPath, writeTaskContract } from "../../src/pr-state/task.ts";
import type { CommandRunner } from "../../src/pr-state/github.ts";

function withTempWorktree(testFn: (root: string) => void): void {
  const parent = mkdtempSync(join(tmpdir(), "domain-state-"));
  const root = join(parent, "GH-339");
  mkdirSync(root, { recursive: true });
  try {
    testFn(root);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function makeRunner(root: string): CommandRunner {
  return (cmd, options) => {
    const joined = cmd.join(" ");
    if (joined === `git -C ${root} rev-parse --show-toplevel`) {
      return { stdout: `${root}\n`, stderr: "", status: 0 };
    }
    if (joined === `git -C ${root} status --porcelain=v1 -b`) {
      return { stdout: "## GH-339...origin/GH-339\n", stderr: "", status: 0 };
    }
    if (
      joined === `git -C ${root} rev-parse --git-path MERGE_HEAD` ||
      joined === `git -C ${root} rev-parse --git-path rebase-apply` ||
      joined === `git -C ${root} rev-parse --git-path rebase-merge` ||
      joined === `git -C ${root} rev-parse --git-path CHERRY_PICK_HEAD`
    ) {
      return { stdout: "", stderr: "", status: 1 };
    }
    if (joined === `git -C ${root} worktree list --porcelain`) {
      return {
        stdout: `worktree ${root}\nHEAD ccc222\nbranch refs/heads/GH-339\n\n`,
        stderr: "",
        status: 0,
      };
    }
    if (cmd[0] === "gh" && cmd[1] === "repo") {
      return { stdout: "owner/repo\n", stderr: "", status: 0 };
    }
    if (
      joined ===
      "gh pr list --state open --json number,headRefName,title,isDraft,url,reviewDecision,statusCheckRollup,mergeable,reviews -R owner/repo"
    ) {
      return { stdout: "[]", stderr: "", status: 0 };
    }
    if (
      joined ===
      "gh pr view --json number,state,isDraft,title,url,headRefName,reviewDecision,statusCheckRollup,mergeable,reviews"
    ) {
      return { stdout: "", stderr: "no pull requests found", status: 1 };
    }
    if (joined === `git -C ${root} fetch --dry-run origin`) {
      return { stdout: "", stderr: "", status: 0 };
    }
    throw new Error(`Unexpected command: ${joined}`);
  };
}

describe("domain state", () => {
  test("builds a canonical domain state from repo/task/contract inputs", () => {
    withTempWorktree((root) => {
      const task = createTaskContract({
        workUnitId: "GH-339",
        worktree: root,
        branch: "GH-339",
      });
      writeTaskContract(defaultTaskPath(root), task);
      mkdirSync(join(root, ".pr", "local"), { recursive: true });
      writeContract(join(root, ".pr", "local", "pr.json"), {
        pr: {
          title: "GH-339",
          lifecycle: { state: "merge_ready", reason: "Scope agreed" },
          ready: { value: true, reason: "Approved" },
        },
      });

      const state = buildDomainState(root, makeRunner(root));

      expect(state).toMatchObject({
        kind: "DomainStateV1",
        ci: { verdict: "unchecked", freshness: "unknown" },
        taskContract: {
          identity: {
            workUnitId: "GH-339",
          },
        },
        prState: {
          pr: {
            exists: false,
          },
          contract: {
            exists: true,
            mode: "ready",
            state: "merge_ready",
          },
          mergeReady: false,
        },
        workflowState: {
          phase: "pushed",
          task: {
            exists: true,
            currentRole: "planner",
          },
        },
        repoState: {
          branch: "GH-339",
          currentUnit: {
            ticket: "GH-339",
            branch: "GH-339",
          },
        },
        reviewState: {
          unresolvedThreads: 0,
          agentReview: false,
          humanReview: false,
          commentsResolved: true,
        },
      });
    });
  });

  test("round-trips through a local snapshot file", () => {
    withTempWorktree((root) => {
      const state = buildDomainState(root, makeRunner(root));
      const path = defaultDomainStatePath(root);

      writeDomainState(path, state);
      const loaded = loadDomainState(path);

      expect(loaded).toEqual(state);
    });
  });

  test("refreshes from the GitHub-backed adapter path", () => {
    withTempWorktree((root) => {
      const state = refreshDomainStateFromGitHub(root, makeRunner(root));

      expect(state.kind).toBe("DomainStateV1");
      expect(state.workflowState.phase).toBe("pushed");
      expect(state.rawState.unitId as string).toBe("GH-339");
    });
  });

  test("accepts unknown PR check status from repo status", () => {
    withTempWorktree((root) => {
      const runner: CommandRunner = (cmd, options) => {
        const joined = cmd.join(" ");
        if (joined === `git -C ${root} rev-parse --show-toplevel`) {
          return { stdout: `${root}\n`, stderr: "", status: 0 };
        }
        if (joined === `git -C ${root} status --porcelain=v1 -b`) {
          return { stdout: "## GH-339...origin/GH-339\n", stderr: "", status: 0 };
        }
        if (
          joined === `git -C ${root} rev-parse --git-path MERGE_HEAD` ||
          joined === `git -C ${root} rev-parse --git-path rebase-apply` ||
          joined === `git -C ${root} rev-parse --git-path rebase-merge` ||
          joined === `git -C ${root} rev-parse --git-path CHERRY_PICK_HEAD`
        ) {
          return { stdout: "", stderr: "", status: 1 };
        }
        if (joined === `git -C ${root} worktree list --porcelain`) {
          return {
            stdout: `worktree ${root}\nHEAD ccc222\nbranch refs/heads/GH-339\n\n`,
            stderr: "",
            status: 0,
          };
        }
        if (cmd[0] === "gh" && cmd[1] === "repo") {
          return { stdout: "owner/repo\n", stderr: "", status: 0 };
        }
        if (
          joined ===
          "gh pr list --state open --json number,headRefName,title,isDraft,url,reviewDecision,statusCheckRollup,mergeable,reviews -R owner/repo"
        ) {
          return {
            stdout: JSON.stringify([
              {
                number: 339,
                headRefName: "GH-339",
                title: "Canonical DomainState",
                isDraft: false,
                url: "https://example.com/pr/339",
                reviewDecision: "APPROVED",
                statusCheckRollup: [],
                mergeable: "MERGEABLE",
                reviews: [],
              },
            ]),
            stderr: "",
            status: 0,
          };
        }
        if (
          joined ===
          "gh pr view --json number,state,isDraft,title,url,headRefName,reviewDecision,statusCheckRollup,mergeable,reviews"
        ) {
          return {
            stdout: JSON.stringify({
              number: 339,
              state: "OPEN",
              isDraft: false,
              title: "Canonical DomainState",
              url: "https://example.com/pr/339",
              headRefName: "GH-339",
              reviewDecision: "APPROVED",
              statusCheckRollup: [],
              mergeable: "MERGEABLE",
              reviews: [],
            }),
            stderr: "",
            status: 0,
          };
        }
        if (
          joined ===
          "gh pr view 339 --json number,title,url,isDraft,baseRefName,reviewDecision,mergeStateStatus,mergeable,autoMergeRequest,reviews"
        ) {
          return {
            stdout: JSON.stringify({
              number: 339,
              title: "Canonical DomainState",
              url: "https://example.com/pr/339",
              isDraft: false,
              baseRefName: "main",
              reviewDecision: "APPROVED",
              mergeStateStatus: "CLEAN",
              mergeable: "MERGEABLE",
              autoMergeRequest: null,
              reviews: [],
            }),
            stderr: "",
            status: 0,
          };
        }
        if (joined === `git -C ${root} fetch --dry-run origin`) {
          return { stdout: "", stderr: "", status: 0 };
        }
        if (
          joined ===
          "gh api graphql -f query=query($owner:String!, $repo:String!, $number:Int!) { repository(owner:$owner, name:$repo) { pullRequest(number:$number) { reviewThreads(first:100) { nodes { id isResolved isOutdated path comments(first:20) { nodes { author { login } body state path createdAt url outdated } } } } } } } -F owner=owner -F repo=repo -F number=339"
        ) {
          return {
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: { nodes: [] },
                  },
                },
              },
            }),
            stderr: "",
            status: 0,
          };
        }
        throw new Error(`Unexpected command: ${joined}`);
      };

      const state = buildDomainState(root, runner);

      expect(state.prState.pr.exists).toBeTrue();
      expect(state.prState.pr.checks).toBe("unknown");
    });
  });
});
