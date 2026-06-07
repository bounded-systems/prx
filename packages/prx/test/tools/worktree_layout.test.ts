// worktree_layout: the placement rule + the pure `git worktree add` core.
// `spawn` is a required seam, so every git branch is driven with a fake.

import { describe, expect, test } from "bun:test";

import {
  addWorktreeForBranch,
  expectedWorktreePath,
  isRegisteredWorktree,
  WorktreeAddError,
  type WorktreeSpawn,
  type WorktreeSpawnResult,
} from "../../src/tools/worktree_layout.ts";

// A spawn that answers each git invocation by matching on argv.
const spawnBy = (handler: (args: string[]) => Partial<WorktreeSpawnResult>): WorktreeSpawn =>
  (_file, args) => ({ status: 0, stdout: "", stderr: "", ...handler(args) });

describe("expectedWorktreePath", () => {
  test("places the worktree as a sibling of the repo toplevel", () => {
    expect(expectedWorktreePath("/repos/prx", "GH-1")).toBe("/repos/GH-1");
  });
  test("nests a slash-bearing branch under the parent dir", () => {
    expect(expectedWorktreePath("/repos/prx", "triage/abc")).toBe("/repos/triage/abc");
  });
});

describe("isRegisteredWorktree", () => {
  test("true when the porcelain list contains the target", () => {
    const spawn = spawnBy(() => ({ status: 0, stdout: "worktree /repos/prx\nworktree /repos/GH-1\n" }));
    expect(isRegisteredWorktree("/repos/prx", "/repos/GH-1", spawn)).toBe(true);
  });
  test("false when the target is absent", () => {
    const spawn = spawnBy(() => ({ status: 0, stdout: "worktree /repos/prx\n" }));
    expect(isRegisteredWorktree("/repos/prx", "/repos/GH-9", spawn)).toBe(false);
  });
  test("false on a non-zero git exit", () => {
    expect(isRegisteredWorktree("/repos/prx", "/x", spawnBy(() => ({ status: 1 })))).toBe(false);
  });
  test("rethrows a raw spawn error", () => {
    const spawn = spawnBy(() => ({ error: new Error("git missing") }));
    expect(() => isRegisteredWorktree("/repos/prx", "/x", spawn)).toThrow(/git missing/);
  });
});

describe("addWorktreeForBranch", () => {
  test("checks out an existing local branch", () => {
    const calls: string[][] = [];
    const spawn: WorktreeSpawn = (_f, args) => {
      calls.push(args);
      // show-ref --verify returns 0 → branch exists.
      return { status: 0, stdout: "", stderr: "" };
    };
    addWorktreeForBranch("/repos/prx", "GH-1", "/repos/GH-1", spawn);
    expect(calls[1]).toEqual(["-C", "/repos/prx", "worktree", "add", "/repos/GH-1", "GH-1"]);
  });

  test("creates a new branch off origin/main when it does not exist", () => {
    const calls: string[][] = [];
    const spawn: WorktreeSpawn = (_f, args) => {
      calls.push(args);
      // show-ref → non-zero (branch missing); worktree add → 0.
      return { status: args.includes("show-ref") ? 1 : 0, stdout: "", stderr: "" };
    };
    addWorktreeForBranch("/repos/prx", "GH-2", "/repos/GH-2", spawn);
    expect(calls[1]).toEqual([
      "-C", "/repos/prx", "worktree", "add", "-b", "GH-2", "/repos/GH-2", "origin/main",
    ]);
  });

  test("throws WorktreeAddError on a non-zero add exit", () => {
    const spawn: WorktreeSpawn = (_f, args) =>
      args.includes("show-ref")
        ? { status: 0 }
        : { status: 128, stderr: "fatal: already exists" };
    expect(() => addWorktreeForBranch("/repos/prx", "GH-1", "/t", spawn)).toThrow(WorktreeAddError);
  });

  test("rethrows a raw spawn error from show-ref", () => {
    const spawn: WorktreeSpawn = () => ({ status: null, error: new Error("spawn boom") });
    expect(() => addWorktreeForBranch("/repos/prx", "GH-1", "/t", spawn)).toThrow(/spawn boom/);
  });

  test("rethrows a raw spawn error from the add step", () => {
    const spawn: WorktreeSpawn = (_f, args) =>
      args.includes("show-ref") ? { status: 0 } : { status: null, error: new Error("add boom") };
    expect(() => addWorktreeForBranch("/repos/prx", "GH-1", "/t", spawn)).toThrow(/add boom/);
  });
});
