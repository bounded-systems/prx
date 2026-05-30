/**
 * GH-914: HEAD-authorship gating for `delete_remote_branch` actions.
 * Two layers under test:
 *   1. `compareOperatorIdentity` semantics surfaced via the action enumerator
 *      (operator-authored / teammate-authored / unknown).
 *   2. `buildSurfaceSyncFromBoard` — the authorship-gated emission of
 *      `delete_remote_branch` for remote-only Pass 3 units.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildSurfaceSyncFromBoard,
  getOperatorIdentity,
  readRemoteBranchAuthors,
  type BoardStatusResult,
  type BoardUnit,
  type CommandRunner,
} from "../../src/pr-state/github.ts";

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gh-914-authorship-"));
  writeFileSync(join(root, "prx.toml"), ['manager = "git"', ""].join("\n"));
  return root;
}

function makeRunner(root: string): CommandRunner {
  return (cmd) => {
    if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
      return { stdout: `${root}\n`, stderr: "", status: 0 };
    }
    throw new Error(`Unexpected command: ${cmd.join(" ")}`);
  };
}

function remoteOnlyUnit(
  branch: string,
  remoteAuthor: BoardUnit["remote_branch_author"],
): BoardUnit {
  return {
    ticket: branch.startsWith("GH-") || branch.includes("-") ? branch : null,
    branch,
    worktree_path: null,
    pr: {
      exists: false,
      number: null,
      title: null,
      url: null,
      draft: null,
      checks: null,
      review: null,
      approvals: null,
      mergeable: null,
    },
    artifacts: { worktree: false, branch: true, pr: false, ticket: true },
    local: { clean: null, staged: null, unstaged: null, untracked: null, conflicts: null },
    status: {
      remote: {
        gh_issue: "clean",
        beads_issue: "clean",
        project_item: "clean",
        branch: "dirty",
        pr: "clean",
        merge_state: "clean",
        ci: "clean",
        problem: "no",
      },
      local: {
        branch: "clean",
        worktree: "clean",
        dir: "no worktree",
        problem: "no",
      },
    },
    remote_branch_author: remoteAuthor,
    column: "pushed",
    reasons: [],
  };
}

function buildBoard(units: BoardUnit[]): BoardStatusResult {
  return {
    source: "derived-board",
    repo: "owner/repo",
    remote_freshness: "fresh",
    units,
  };
}

describe("buildSurfaceSyncFromBoard authorship gate (GH-914)", () => {
  test("teammate-authored remote-only unit yields no delete_remote_branch action", () => {
    const root = makeRoot();
    const board = buildBoard([
      remoteOnlyUnit("PROJ-5767", {
        name: "Dana Dev",
        email: "dana@example.com",
        isOperator: false,
      }),
    ]);

    const result = buildSurfaceSyncFromBoard(
      root,
      board,
      { mode: "full", authority: "issue", scope: "all" },
      makeRunner(root),
    );

    const deletes = result.actions.filter((a) => a.type === "delete_remote_branch");
    expect(deletes).toHaveLength(0);
  });

  test("operator-authored remote-only unit emits delete_remote_branch as before", () => {
    const root = makeRoot();
    const board = buildBoard([
      remoteOnlyUnit("GH-101", {
        name: "Operator",
        email: "me@example.com",
        isOperator: true,
      }),
    ]);

    const result = buildSurfaceSyncFromBoard(
      root,
      board,
      { mode: "full", authority: "issue", scope: "all" },
      makeRunner(root),
    );

    const deletes = result.actions.filter((a) => a.type === "delete_remote_branch");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.branch).toBe("GH-101");
  });

  test("unknown authorship (null) preserves emit — fail open on broken setup", () => {
    const root = makeRoot();
    const board = buildBoard([
      remoteOnlyUnit("GH-202", {
        name: "?",
        email: "",
        isOperator: null,
      }),
    ]);

    const result = buildSurfaceSyncFromBoard(
      root,
      board,
      { mode: "full", authority: "issue", scope: "all" },
      makeRunner(root),
    );

    const deletes = result.actions.filter((a) => a.type === "delete_remote_branch");
    expect(deletes).toHaveLength(1);
  });

  test("missing remote_branch_author field (legacy units) preserves emit", () => {
    // Pre-GH-914 BoardUnits never set this field. Action enumerator must keep
    // emitting `delete_remote_branch` so we don't regress closed work
    // (GH-519 / GH-830 / GH-688) that depends on the prune path firing.
    const root = makeRoot();
    const board = buildBoard([remoteOnlyUnit("GH-303", undefined)]);

    const result = buildSurfaceSyncFromBoard(
      root,
      board,
      { mode: "full", authority: "issue", scope: "all" },
      makeRunner(root),
    );

    const deletes = result.actions.filter((a) => a.type === "delete_remote_branch");
    expect(deletes).toHaveLength(1);
  });

  test("getOperatorIdentity returns null when neither user.email nor user.name is configured", () => {
    const runner: CommandRunner = (cmd) => {
      if (cmd.includes("user.email") || cmd.includes("user.name")) {
        return { stdout: "", stderr: "", status: 1 };
      }
      throw new Error(`unexpected: ${cmd.join(" ")}`);
    };
    expect(getOperatorIdentity("/tmp", runner)).toBeNull();
  });

  test("getOperatorIdentity returns the configured identity", () => {
    const runner: CommandRunner = (cmd) => {
      if (cmd.includes("user.email")) return { stdout: "Me@Example.com\n", stderr: "", status: 0 };
      if (cmd.includes("user.name")) return { stdout: "Operator\n", stderr: "", status: 0 };
      throw new Error(`unexpected: ${cmd.join(" ")}`);
    };
    expect(getOperatorIdentity("/tmp", runner)).toEqual({ name: "Operator", email: "Me@Example.com" });
  });

  test("readRemoteBranchAuthors normalizes emails and skips origin/HEAD pointers", () => {
    const runner: CommandRunner = (cmd) => {
      if (cmd[3] === "for-each-ref") {
        return {
          stdout: [
            "origin/HEAD\t<>\t",
            "origin/main\t<core@example.com>\tCore Bot",
            "origin/PROJ-5767\t<dana@Example.com>\tDana Dev",
            "origin/GH-101\t<me@example.com>\tOperator",
            "",
          ].join("\n"),
          stderr: "",
          status: 0,
        };
      }
      throw new Error(`unexpected: ${cmd.join(" ")}`);
    };
    const map = readRemoteBranchAuthors("/tmp", runner);
    expect(map.has("HEAD")).toBe(false);
    expect(map.get("main")).toEqual({ name: "Core Bot", email: "core@example.com" });
    expect(map.get("PROJ-5767")).toEqual({ name: "Dana Dev", email: "dana@example.com" });
    expect(map.get("GH-101")).toEqual({ name: "Operator", email: "me@example.com" });
  });

  test("mixed board: gate applies per unit, not globally", () => {
    const root = makeRoot();
    const board = buildBoard([
      remoteOnlyUnit("PROJ-5767", {
        name: "Dana Dev",
        email: "dana@example.com",
        isOperator: false,
      }),
      remoteOnlyUnit("GH-404", {
        name: "Operator",
        email: "me@example.com",
        isOperator: true,
      }),
    ]);

    const result = buildSurfaceSyncFromBoard(
      root,
      board,
      { mode: "full", authority: "issue", scope: "all" },
      makeRunner(root),
    );

    const deletes = result.actions.filter((a) => a.type === "delete_remote_branch");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.branch).toBe("GH-404");
  });
});
