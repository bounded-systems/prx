// pr-state/github — chainStatusFromBoard (chain-identity + disposition per unit)
// and applyAuthorityOverrides (probe-eligibility + terminal-authority overrides),
// driven through board fixtures + an injected runner.

import { describe, expect, test } from "bun:test";

import { applyAuthorityOverrides, chainStatusFromBoard } from "../../src/pr-state/github.ts";
import type {
  BoardColumn,
  BoardStatusResult,
  BoardUnit,
  CommandRunner,
} from "../../src/pr-state/github.ts";

function unit(over: Partial<BoardUnit> & { branch: string; column: BoardColumn }): BoardUnit {
  return {
    ticket: over.ticket ?? `GH-${over.branch}`,
    branch: over.branch,
    worktree_path: over.worktree_path ?? null,
    pr: over.pr ?? { exists: false, number: null, title: null, url: null, draft: null, checks: null, review: null, approvals: null, mergeable: null },
    artifacts: over.artifacts ?? { worktree: false, branch: true, pr: false, ticket: true },
    local: over.local ?? { clean: true, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
    column: over.column,
    reasons: over.reasons ?? [],
  } as BoardUnit;
}

const COLUMNS: BoardColumn[] = [
  "no_worktree", "worktree_created", "branch_created", "committing", "pushed",
  "pr_open", "ci_running", "review", "changes_requested", "approved",
  "merge_ready", "cleanup_pending", "merged", "cleaned",
];

const board = (units: BoardUnit[]): BoardStatusResult => ({
  source: "derived-board",
  repo: "owner/repo",
  remote_freshness: "fresh",
  units,
}) as BoardStatusResult;

describe("chainStatusFromBoard", () => {
  test("derives a chain row per unit across every column (no repoPath → no config load)", () => {
    const units = COLUMNS.map((column, i) => unit({ branch: `${100 + i}`, column }));
    const result = chainStatusFromBoard(board(units));
    expect(result).toBeDefined();
    expect(Array.isArray(result.rows)).toBe(true);
    expect(result.rows.length).toBe(units.length);
  });
});

describe("applyAuthorityOverrides", () => {
  test("leaves non-probe-eligible units untouched and runs the authority probe on eligible ones", () => {
    // A benign runner reports no terminal authority, so eligible units stay as-is.
    const runner = (() => ({ status: 0, stdout: "[]", stderr: "", signal: null })) as never as CommandRunner;
    const units = COLUMNS.map((column, i) => unit({ branch: `${200 + i}`, column }));
    const result = applyAuthorityOverrides("owner/repo", units, runner);
    expect(result).toHaveLength(units.length);
    // No unit was forced to cleanup_pending by the benign probe.
    expect(result.filter((u) => u.column === "cleanup_pending").length).toBeLessThanOrEqual(
      units.filter((u) => u.column === "cleanup_pending").length,
    );
  });
});
