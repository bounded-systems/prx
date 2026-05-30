import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  BranchStore,
  RepositoryStore,
  WorkspaceStore,
  openRegistry,
} from "../../src/pr-state/registry_store.ts";
import {
  adoptWorkspace,
  inferWorkspaceFromWorktree,
} from "../../src/pr-state/workspace_adopt.ts";
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

function attachedHeadResponses(
  branchName: string,
  dirtyOutput = "",
): Map<string, RunnerResponse> {
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
  m.set(`git -C ${WORKTREE} status --porcelain|`, {
    stdout: dirtyOutput,
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
  m.set(`git -C ${WORKTREE} status --porcelain|`, {
    stdout: "",
    stderr: "",
    status: 0,
  });
  return m;
}

function withRegistry<T>(
  fn: (
    repoStore: RepositoryStore,
    branchStore: BranchStore,
    workspaceStore: WorkspaceStore,
  ) => T,
): T {
  const dir = mkdtempSync(join(tmpdir(), "prx-workspace-adopt-"));
  try {
    const db = openRegistry(join(dir, "registry.sqlite"));
    try {
      return fn(
        new RepositoryStore(db),
        new BranchStore(db),
        new WorkspaceStore(db),
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("inferWorkspaceFromWorktree", () => {
  test("returns dirty=false when `git status --porcelain` is empty", () => {
    const runner = makeRunner(
      new Map([
        [
          `git -C ${WORKTREE} status --porcelain|`,
          { stdout: "", stderr: "", status: 0 },
        ],
      ]),
    );
    const inferred = inferWorkspaceFromWorktree(WORKTREE, runner);
    expect(inferred.path).toBe(WORKTREE);
    expect(inferred.dirty).toBe(false);
  });

  test("returns dirty=true when porcelain output is non-empty", () => {
    const runner = makeRunner(
      new Map([
        [
          `git -C ${WORKTREE} status --porcelain|`,
          { stdout: " M src/x.ts\n", stderr: "", status: 0 },
        ],
      ]),
    );
    const inferred = inferWorkspaceFromWorktree(WORKTREE, runner);
    expect(inferred.dirty).toBe(true);
  });

  test("throws CliError when `git status` exits non-zero", () => {
    const runner = makeRunner(
      new Map([
        [
          `git -C ${WORKTREE} status --porcelain|`,
          { stdout: "", stderr: "fatal: not a git repository", status: 128 },
        ],
      ]),
    );
    expect(() => inferWorkspaceFromWorktree(WORKTREE, runner)).toThrow(CliError);
  });
});

describe("adoptWorkspace", () => {
  test("fresh adopt cascades repo + branch + workspace; re-run preserves adopted_at", () => {
    withRegistry((repoStore, branchStore, workspaceStore) => {
      const runner = makeRunner(attachedHeadResponses("GH-1762"));

      const first = adoptWorkspace({
        worktreePath: WORKTREE,
        repoStore,
        branchStore,
        workspaceStore,
        runner,
        now: () => new Date("2026-05-15T12:00:00.000Z"),
      });
      expect(first.kind).toBe("adopted");
      expect(first.row.workspace_id).toBe("github.com/bdelanghe/ai-home:GH-1762");
      expect(first.row.path).toBe(WORKTREE);
      expect(first.row.mode).toBe("write");
      expect(first.row.state).toBe("ready");
      expect(first.row.dirty).toBe(false);
      expect(first.row.adopted_at).toBe("2026-05-15T12:00:00.000Z");
      expect(first.chain.repo.kind).toBe("adopted");
      expect(first.chain.branch.kind).toBe("adopted");

      const second = adoptWorkspace({
        worktreePath: WORKTREE,
        repoStore,
        branchStore,
        workspaceStore,
        runner,
        now: () => new Date("2027-01-01T00:00:00.000Z"),
      });
      expect(second.kind).toBe("already-adopted");
      expect(second.row.adopted_at).toBe("2026-05-15T12:00:00.000Z");
      expect(second.chain.repo.kind).toBe("already-adopted");
      expect(second.chain.branch.kind).toBe("already-adopted");
      expect(workspaceStore.count()).toBe(1);
    });
  });

  test("dirty tree records dirty=true; re-adopt updates dirty while preserving adopted_at", () => {
    withRegistry((repoStore, branchStore, workspaceStore) => {
      const dirtyRunner = makeRunner(attachedHeadResponses("GH-1762", " M src/x.ts\n"));
      const first = adoptWorkspace({
        worktreePath: WORKTREE,
        repoStore,
        branchStore,
        workspaceStore,
        runner: dirtyRunner,
        now: () => new Date("2026-05-15T12:00:00.000Z"),
      });
      expect(first.row.dirty).toBe(true);

      const cleanRunner = makeRunner(attachedHeadResponses("GH-1762"));
      const second = adoptWorkspace({
        worktreePath: WORKTREE,
        repoStore,
        branchStore,
        workspaceStore,
        runner: cleanRunner,
        now: () => new Date("2027-01-01T00:00:00.000Z"),
      });
      expect(second.kind).toBe("already-adopted");
      expect(second.row.dirty).toBe(false);
      expect(second.row.adopted_at).toBe("2026-05-15T12:00:00.000Z");
    });
  });

  test("detached HEAD without --detached-as bubbles the curated error", () => {
    withRegistry((repoStore, branchStore, workspaceStore) => {
      const runner = makeRunner(detachedHeadResponses());
      expect(() =>
        adoptWorkspace({
          worktreePath: WORKTREE,
          repoStore,
          branchStore,
          workspaceStore,
          runner,
        }),
      ).toThrow(/detached HEAD/);
    });
  });

  test("detached HEAD with --detached-as adopts under that name", () => {
    withRegistry((repoStore, branchStore, workspaceStore) => {
      const runner = makeRunner(detachedHeadResponses());
      const result = adoptWorkspace({
        worktreePath: WORKTREE,
        repoStore,
        branchStore,
        workspaceStore,
        runner,
        detachedAs: "scratch",
        now: () => new Date("2026-05-15T12:00:00.000Z"),
      });
      expect(result.kind).toBe("adopted");
      expect(result.row.workspace_id).toBe("github.com/bdelanghe/ai-home:scratch");
      expect(result.row.branch_id).toBe("github.com/bdelanghe/ai-home:scratch");
    });
  });

  test("workspace_id collision at a different path refuses with the disagrees wording", () => {
    withRegistry((repoStore, branchStore, workspaceStore) => {
      const runner = makeRunner(attachedHeadResponses("GH-1762"));
      adoptWorkspace({
        worktreePath: WORKTREE,
        repoStore,
        branchStore,
        workspaceStore,
        runner,
        now: () => new Date("2026-05-15T12:00:00.000Z"),
      });

      // Same branch identity, different path — should refuse.
      const OTHER_WT = "/wt/secondary";
      const otherMap = new Map<string, RunnerResponse>([
        [
          `git rev-parse --git-common-dir|${OTHER_WT}`,
          { stdout: `${BARE}\n`, stderr: "", status: 0 },
        ],
        [
          `git remote get-url origin|${OTHER_WT}`,
          { stdout: `${ORIGIN}\n`, stderr: "", status: 0 },
        ],
        [
          `git symbolic-ref --short refs/remotes/origin/HEAD|${OTHER_WT}`,
          { stdout: "origin/main\n", stderr: "", status: 0 },
        ],
        [
          `git rev-parse HEAD|${OTHER_WT}`,
          { stdout: `${HEAD_SHA}\n`, stderr: "", status: 0 },
        ],
        [
          `git symbolic-ref --short HEAD|${OTHER_WT}`,
          { stdout: "GH-1762\n", stderr: "", status: 0 },
        ],
        [
          `git -C ${OTHER_WT} status --porcelain|`,
          { stdout: "", stderr: "", status: 0 },
        ],
      ]);
      // Repo-side identity check refuses first (bare/origin match but repo
      // already registered at a different bare_path would be the relevant
      // mismatch). Here the bare_path is identical, so repo adopt succeeds —
      // workspace_adopt's own path-mismatch arm trips.
      const otherRunner = makeRunner(otherMap);
      expect(() =>
        adoptWorkspace({
          worktreePath: OTHER_WT,
          repoStore,
          branchStore,
          workspaceStore,
          runner: otherRunner,
          now: () => new Date("2026-05-16T12:00:00.000Z"),
        }),
      ).toThrow(/disagrees/);
    });
  });

  test("--mode read writes mode=read", () => {
    withRegistry((repoStore, branchStore, workspaceStore) => {
      const runner = makeRunner(attachedHeadResponses("GH-1762"));
      const result = adoptWorkspace({
        worktreePath: WORKTREE,
        repoStore,
        branchStore,
        workspaceStore,
        runner,
        mode: "read",
        now: () => new Date("2026-05-15T12:00:00.000Z"),
      });
      expect(result.row.mode).toBe("read");
    });
  });
});
