import { describe, expect, test } from "bun:test";

import {
  inferOperatorScopeFromCwd,
  isMainxPath,
  isMainxWorktree,
  type CommandRunner,
} from "../../src/pr-state/scope-inference.ts";

type Stub = { stdout?: string; stderr?: string; status?: number | null };

function makeRunner(
  responses: Record<string, Stub>,
): { runner: CommandRunner; calls: { cmd: string; args: string[]; cwd: string }[] } {
  const calls: { cmd: string; args: string[]; cwd: string }[] = [];
  const runner: CommandRunner = (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], cwd: opts.cwd });
    const key = [cmd, ...args].join(" ");
    const stub = responses[key];
    if (!stub) {
      return { stdout: "", stderr: `unstubbed: ${key}`, status: 1 };
    }
    return {
      stdout: stub.stdout ?? "",
      stderr: stub.stderr ?? "",
      status: stub.status ?? 0,
    };
  };
  return { runner, calls };
}

describe("inferOperatorScopeFromCwd", () => {
  test("ai-home cwd → prx scope", () => {
    const { runner } = makeRunner({
      "git -C /repo remote get-url origin": {
        stdout: "git@github.com:bdelanghe/ai-home.git\n",
      },
      "git -C /repo rev-parse --show-toplevel": {
        stdout: "/Users/dev/.local/state/wt/worktrees/main/gh_876_vjg\n",
      },
    });
    expect(inferOperatorScopeFromCwd("/repo", runner)).toEqual({
      scope: "prx",
      source: "git-remote",
      mapping: "bdelanghe/ai-home",
    });
  });

  test("unmapped repo → skipped (no-mapping)", () => {
    const { runner } = makeRunner({
      "git -C /repo remote get-url origin": {
        stdout: "https://github.com/demo/demo-web.git",
      },
      "git -C /repo rev-parse --show-toplevel": {
        stdout: "/some/worktree/gh_5431_xyz\n",
      },
    });
    expect(inferOperatorScopeFromCwd("/repo", runner)).toEqual({
      scope: null,
      source: "skipped",
      reason: "no-mapping",
    });
  });

  test("mainx worktree → skipped, even when origin maps", () => {
    const { runner } = makeRunner({
      "git -C /repo remote get-url origin": {
        stdout: "git@github.com:bdelanghe/ai-home.git",
      },
      "git -C /repo rev-parse --show-toplevel": {
        stdout: "/Users/dev/.local/state/wt/worktrees/main/mainx",
      },
    });
    expect(inferOperatorScopeFromCwd("/repo", runner)).toEqual({
      scope: null,
      source: "skipped",
      reason: "mainx",
    });
  });

  test("no origin remote → skipped", () => {
    const { runner } = makeRunner({
      "git -C /repo remote get-url origin": { status: 128, stderr: "fatal: No such remote" },
    });
    expect(inferOperatorScopeFromCwd("/repo", runner)).toEqual({
      scope: null,
      source: "skipped",
      reason: "no-remote",
    });
  });

  test("non-GitHub remote → skipped (no-remote)", () => {
    const { runner } = makeRunner({
      "git -C /repo remote get-url origin": { stdout: "https://gitlab.com/foo/bar.git" },
    });
    expect(inferOperatorScopeFromCwd("/repo", runner)).toEqual({
      scope: null,
      source: "skipped",
      reason: "no-remote",
    });
  });

  test("unmapped GitHub repo → skipped (no-mapping)", () => {
    const { runner } = makeRunner({
      "git -C /repo remote get-url origin": {
        stdout: "git@github.com:someone/random-repo.git",
      },
      "git -C /repo rev-parse --show-toplevel": { stdout: "/repo" },
    });
    expect(inferOperatorScopeFromCwd("/repo", runner)).toEqual({
      scope: null,
      source: "skipped",
      reason: "no-mapping",
    });
  });

  test("toplevel command failure does not block inference (treats as not-mainx)", () => {
    const { runner } = makeRunner({
      "git -C /repo remote get-url origin": {
        stdout: "git@github.com:bdelanghe/ai-home.git",
      },
      "git -C /repo rev-parse --show-toplevel": { status: 128 },
    });
    expect(inferOperatorScopeFromCwd("/repo", runner)).toEqual({
      scope: "prx",
      source: "git-remote",
      mapping: "bdelanghe/ai-home",
    });
  });
});

describe("isMainxPath", () => {
  test("basename mainx → true", () => {
    expect(isMainxPath("/Users/dev/.local/state/wt/worktrees/main/mainx")).toBe(true);
  });

  test("trailing-slash mainx path → true", () => {
    expect(isMainxPath("/wt/worktrees/main/mainx/")).toBe(true);
  });

  test("feature worktree → false", () => {
    expect(isMainxPath("/Users/dev/.local/state/wt/worktrees/main/gh_893_g0j")).toBe(false);
  });

  test("path that merely contains mainx as a segment → false", () => {
    expect(isMainxPath("/wt/mainx/GH-2281")).toBe(false);
  });
});

describe("isMainxWorktree", () => {
  test("returns true when toplevel basename is mainx", () => {
    const { runner } = makeRunner({
      "git -C /repo rev-parse --show-toplevel": {
        stdout: "/Users/dev/.local/state/wt/worktrees/main/mainx\n",
      },
    });
    expect(isMainxWorktree("/repo", runner)).toBe(true);
  });

  test("returns false for a feature worktree", () => {
    const { runner } = makeRunner({
      "git -C /repo rev-parse --show-toplevel": {
        stdout: "/Users/dev/.local/state/wt/worktrees/main/gh_893_g0j\n",
      },
    });
    expect(isMainxWorktree("/repo", runner)).toBe(false);
  });

  test("returns false when git rev-parse fails", () => {
    const { runner } = makeRunner({
      "git -C /repo rev-parse --show-toplevel": { status: 128, stderr: "fatal: not a git repo" },
    });
    expect(isMainxWorktree("/repo", runner)).toBe(false);
  });
});
