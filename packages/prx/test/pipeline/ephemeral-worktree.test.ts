// prx-g88.5 — ephemeral salted worktrees: derivation, create/destroy command
// sequences, cleanup-on-throw (the lifecycle), and the orphan sweep.

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import type { execGit } from "@bounded-systems/git";
import {
  EPHEMERAL_WORKTREE_DIR,
  createEphemeralActorWorktree,
  destroyEphemeralActorWorktree,
  ephemeralWorktreeHandle,
  sweepOrphanedActorWorktrees,
  withEphemeralActorWorktree,
} from "../../src/pipeline/ephemeral-worktree.ts";

type GitCall = { sub: string; args: string[] };

function fakeGit(opts: { listStdout?: string; failAdd?: boolean } = {}) {
  const calls: GitCall[] = [];
  const fn = ((o: { subcommand: string; args: string[] }) => {
    calls.push({ sub: o.subcommand, args: o.args });
    if (o.subcommand === "worktree" && o.args[0] === "add" && opts.failAdd) {
      return { exitCode: 1, stdout: "", stderr: "add boom", policy: null };
    }
    if (o.subcommand === "worktree" && o.args[0] === "list") {
      return { exitCode: 0, stdout: opts.listStdout ?? "", stderr: "", policy: null };
    }
    return { exitCode: 0, stdout: "", stderr: "", policy: null };
  }) as unknown as typeof execGit & { calls: GitCall[] };
  (fn as unknown as { calls: GitCall[] }).calls = calls;
  return fn as typeof execGit & { calls: GitCall[] };
}

const SPEC = {
  actor: "keeper",
  unit: "prx-2c4",
  sourcePinnedDigest: "sha256:" + "a".repeat(64),
  repoRoot: "/repo",
};

describe("ephemeralWorktreeHandle (prx-g88.5)", () => {
  test("path is under .wt/, branch embeds actor/unit/salt", () => {
    const h = ephemeralWorktreeHandle(SPEC);
    expect(h.path).toBe(resolve("/repo", EPHEMERAL_WORKTREE_DIR, `keeper-${h.salt}`));
    expect(h.branch).toBe(`keeper/prx-2c4-${h.salt}`);
  });

  test("two actors on the same unit get different paths (isolation)", () => {
    const k = ephemeralWorktreeHandle(SPEC);
    const f = ephemeralWorktreeHandle({ ...SPEC, actor: "forge" });
    expect(k.path).not.toBe(f.path);
    expect(k.branch).not.toBe(f.branch);
  });
});

describe("create / destroy (prx-g88.5)", () => {
  test("create cuts the salted branch from the base", () => {
    const git = fakeGit();
    const h = createEphemeralActorWorktree({ ...SPEC, base: "origin/main" }, { git });
    const add = git.calls.find((c) => c.sub === "worktree" && c.args[0] === "add")!;
    expect(add.args).toEqual(["add", "-b", h.branch, h.path, "origin/main"]);
  });

  test("create throws on a failing worktree add", () => {
    const git = fakeGit({ failAdd: true });
    expect(() => createEphemeralActorWorktree(SPEC, { git })).toThrow(
      /ephemeral worktree add failed/,
    );
  });

  test("destroy removes the worktree and deletes the branch", () => {
    const git = fakeGit();
    const h = ephemeralWorktreeHandle(SPEC);
    destroyEphemeralActorWorktree(h, { git, exists: () => false, remove: () => {} });
    const subs = git.calls.map((c) => `${c.sub} ${c.args[0]}`);
    expect(subs).toContain("worktree remove");
    expect(subs).toContain("branch -D");
    expect(subs).toContain("worktree prune");
  });
});

describe("withEphemeralActorWorktree lifecycle (prx-g88.5)", () => {
  test("destroys the worktree even when the body throws", async () => {
    const git = fakeGit();
    await expect(
      withEphemeralActorWorktree(
        SPEC,
        () => {
          throw new Error("body failed");
        },
        { git, exists: () => false, remove: () => {} },
      ),
    ).rejects.toThrow("body failed");
    // create (add) happened, and cleanup (remove) still ran.
    const subs = git.calls.map((c) => `${c.sub} ${c.args[0]}`);
    expect(subs).toContain("worktree add");
    expect(subs).toContain("worktree remove");
  });

  test("returns the body result on success and cleans up", async () => {
    const git = fakeGit();
    const out = await withEphemeralActorWorktree(SPEC, (h) => h.branch, {
      git,
      exists: () => false,
      remove: () => {},
    });
    expect(out).toContain("keeper/prx-2c4-");
    expect(git.calls.some((c) => c.sub === "worktree" && c.args[0] === "remove")).toBe(true);
  });
});

describe("sweepOrphanedActorWorktrees (prx-g88.5)", () => {
  test("removes only worktrees under .wt/, honoring isOrphan", () => {
    const wt = join(resolve("/repo"), EPHEMERAL_WORKTREE_DIR);
    const listStdout = [
      `worktree ${resolve("/repo")}`, // the main worktree — not under .wt/
      `worktree ${wt}/keeper-aaa111`,
      `worktree ${wt}/forge-bbb222`,
      "",
    ].join("\n");
    const git = fakeGit({ listStdout });
    const removed = sweepOrphanedActorWorktrees("/repo", {
      git,
      isOrphan: (p) => p.endsWith("keeper-aaa111"), // only the keeper one is dead
    });
    expect(removed).toEqual([`${wt}/keeper-aaa111`]);
    // The main worktree and the live forge worktree are untouched.
    const removes = git.calls.filter((c) => c.sub === "worktree" && c.args[0] === "remove");
    expect(removes).toHaveLength(1);
  });
});
