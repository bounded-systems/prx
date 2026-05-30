import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  BranchStore,
  RepositoryStore,
  openRegistry,
} from "../../src/pr-state/registry_store.ts";
import {
  adoptBranch,
  inferBranchFromWorktree,
} from "../../src/pr-state/branch_adopt.ts";
import { CliError } from "../../src/pr-state/cli.ts";
import type { RepoRunner } from "../../src/pr-state/repos.ts";

type RunnerResponse = { stdout: string; stderr: string; status: number };

function makeRunner(map: Map<string, RunnerResponse>): RepoRunner {
  return (cmd, options = {}) => {
    const key = `${cmd.join(" ")}|${options.cwd ?? ""}`;
    const r = map.get(key);
    if (!r) return { stdout: "", stderr: `unmocked: ${key}`, status: 1 };
    return r;
  };
}

const WORKTREE = "/wt/main";
const BARE = "/var/git/bare/io.github/bdelanghe/ai-home.git";
const ORIGIN = "https://github.com/bdelanghe/ai-home.git";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

function repoInferenceResponses(): Map<string, RunnerResponse> {
  return new Map<string, RunnerResponse>([
    [
      `git rev-parse --git-common-dir|${WORKTREE}`,
      { stdout: `${BARE}\n`, stderr: "", status: 0 },
    ],
    [
      `git remote get-url origin|${WORKTREE}`,
      { stdout: `${ORIGIN}\n`, stderr: "", status: 0 },
    ],
    [
      `git symbolic-ref --short refs/remotes/origin/HEAD|${WORKTREE}`,
      { stdout: "origin/main\n", stderr: "", status: 0 },
    ],
  ]);
}

function attachedHeadResponses(branchName: string): Map<string, RunnerResponse> {
  const m = repoInferenceResponses();
  m.set(`git rev-parse HEAD|${WORKTREE}`, {
    stdout: `${HEAD_SHA}\n`,
    stderr: "",
    status: 0,
  });
  m.set(`git symbolic-ref --short HEAD|${WORKTREE}`, {
    stdout: `${branchName}\n`,
    stderr: "",
    status: 0,
  });
  return m;
}

function detachedHeadResponses(): Map<string, RunnerResponse> {
  const m = repoInferenceResponses();
  m.set(`git rev-parse HEAD|${WORKTREE}`, {
    stdout: `${HEAD_SHA}\n`,
    stderr: "",
    status: 0,
  });
  m.set(`git symbolic-ref --short HEAD|${WORKTREE}`, {
    stdout: "",
    stderr: "fatal: ref HEAD is not a symbolic ref",
    status: 128,
  });
  return m;
}

function withRegistry<T>(fn: (repoStore: RepositoryStore, branchStore: BranchStore) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "prx-branch-adopt-"));
  try {
    const db = openRegistry(join(dir, "registry.sqlite"));
    try {
      return fn(new RepositoryStore(db), new BranchStore(db));
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function adoptOwningRepo(repoStore: RepositoryStore): void {
  repoStore.upsertRepo({
    repo_id: "github.com/bdelanghe/ai-home",
    bare_path: BARE,
    remote_url: ORIGIN,
    default_branch: "main",
    managed_by: "prx",
    adopted_at: "2026-05-15T12:00:00.000Z",
  });
}

describe("inferBranchFromWorktree", () => {
  test("returns the branch name + head_sha when HEAD is attached", () => {
    const runner = makeRunner(attachedHeadResponses("GH-1761"));
    const inferred = inferBranchFromWorktree(WORKTREE, runner);
    expect(inferred.name).toBe("GH-1761");
    expect(inferred.head_sha).toBe(HEAD_SHA);
  });

  test("returns name=null when HEAD is detached", () => {
    const runner = makeRunner(detachedHeadResponses());
    const inferred = inferBranchFromWorktree(WORKTREE, runner);
    expect(inferred.name).toBeNull();
    expect(inferred.head_sha).toBe(HEAD_SHA);
  });
});

describe("adoptBranch", () => {
  test("fresh adopt writes a branch row; re-run preserves adopted_at", () => {
    withRegistry((repoStore, branchStore) => {
      adoptOwningRepo(repoStore);
      const runner = makeRunner(attachedHeadResponses("GH-1761"));

      const first = adoptBranch({
        worktreePath: WORKTREE,
        repoStore,
        branchStore,
        runner,
        now: () => new Date("2026-05-15T12:00:00.000Z"),
      });
      expect(first.kind).toBe("adopted");
      expect(first.row.branch_id).toBe("github.com/bdelanghe/ai-home:GH-1761");
      expect(first.row.head_sha).toBe(HEAD_SHA);
      expect(first.row.adopted_at).toBe("2026-05-15T12:00:00.000Z");

      const second = adoptBranch({
        worktreePath: WORKTREE,
        repoStore,
        branchStore,
        runner,
        now: () => new Date("2027-01-01T00:00:00.000Z"),
      });
      expect(second.kind).toBe("already-adopted");
      expect(second.row.adopted_at).toBe("2026-05-15T12:00:00.000Z");
      expect(branchStore.count()).toBe(1);
    });
  });

  test("detached HEAD refuses without --detached-as", () => {
    withRegistry((repoStore, branchStore) => {
      adoptOwningRepo(repoStore);
      const runner = makeRunner(detachedHeadResponses());
      expect(() =>
        adoptBranch({
          worktreePath: WORKTREE,
          repoStore,
          branchStore,
          runner,
        }),
      ).toThrow(/detached HEAD/);
    });
  });

  test("detached HEAD with --detached-as adopts under that name", () => {
    withRegistry((repoStore, branchStore) => {
      adoptOwningRepo(repoStore);
      const runner = makeRunner(detachedHeadResponses());
      const result = adoptBranch({
        worktreePath: WORKTREE,
        repoStore,
        branchStore,
        runner,
        detachedAs: "scratch",
        now: () => new Date("2026-05-15T12:00:00.000Z"),
      });
      expect(result.kind).toBe("adopted");
      expect(result.row.name).toBe("scratch");
      expect(result.row.branch_id).toBe("github.com/bdelanghe/ai-home:scratch");
    });
  });

  test("--detached-as with an unsafe name refuses", () => {
    withRegistry((repoStore, branchStore) => {
      adoptOwningRepo(repoStore);
      const runner = makeRunner(detachedHeadResponses());
      expect(() =>
        adoptBranch({
          worktreePath: WORKTREE,
          repoStore,
          branchStore,
          runner,
          detachedAs: "..; rm -rf /",
        }),
      ).toThrow(CliError);
    });
  });

  test("adopting a branch before the owning repo is in the registry refuses", () => {
    withRegistry((repoStore, branchStore) => {
      const runner = makeRunner(attachedHeadResponses("GH-1761"));
      expect(() =>
        adoptBranch({ worktreePath: WORKTREE, repoStore, branchStore, runner }),
      ).toThrow(/repo .* is not in the registry yet/);
    });
  });
});
