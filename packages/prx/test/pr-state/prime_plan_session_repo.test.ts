// GH-1643: `prx plan session --repo <slug>` plumbing — slug→bare resolution,
// force-materialization at the target repo's cwd, and launchCwd resolution
// against the target worktree.
//
// These tests run through `runCli` so we exercise the parser + primePlanSession
// + handler dispatch in one shot. The session-entry XState machine is left
// pure: the OPEN_PLAN_SESSION event payload is unchanged.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import type {
  LocalRepo,
  RepoInventory,
  RepoInventoryConfig,
} from "../../src/pr-state/repos.ts";
import { runCli as runCliDirect } from "../../src/pr-state/cli.ts";

function bareRepo(name: string, commonDir: string, ownerName?: string): LocalRepo {
  return {
    name,
    commonDir,
    kind: "bare",
    mainWorktree: null,
    worktrees: [],
    localOnlyBranches: [],
    findings: [],
    remotes: [],
    primaryRemote: ownerName
      ? {
          name: "origin",
          url: `git@github.com:${ownerName}.git`,
          githubRepo: ownerName,
        }
      : null,
    upstreamRemote: null,
  };
}

function inventoryWith(repos: LocalRepo[]): RepoInventory {
  return { roots: [], repos };
}

function inventoryConfigStub(): RepoInventoryConfig {
  return {
    repoRoot: null,
    bareRoot: null,
    roots: [],
    everywhereRoots: [],
    globalConfigPath: null,
    configPath: null,
    indexPath: null,
  };
}

function issueBackedDeps(workUnitId: string) {
  return {
    pruneStaleRemoteRefs: () => {},
    // GH-1983: bypass the detached-HEAD preflight — these tests hand in a
    // bare mkdtemp dir as the launch worktree, which on CI lands inside
    // the host repo (TMPDIR override) where the GitHub-Actions checkout
    // is on a detached HEAD.
    assertWorktreeOnNamedBranch: () => null,
    boardStatus: () => ({
      source: "derived-board" as const,
      repo: "owner/repo",
      remote_freshness: "fresh" as const,
      units: [
        {
          ticket: workUnitId,
          branch: workUnitId,
          worktree_path: `/repo/${workUnitId}`,
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
          artifacts: { worktree: true, branch: true, pr: false, ticket: true },
          local: { clean: true, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
          status: {
            remote: {
              gh_issue: "dirty" as const,
              beads_issue: "clean" as const,
              project_item: "clean" as const,
              branch: "dirty" as const,
              pr: "clean" as const,
              merge_state: "clean" as const,
              ci: "clean" as const,
              problem: "no" as const,
            },
            local: {
              branch: "clean" as const,
              worktree: "clean" as const,
              dir: "present" as const,
              problem: "no" as const,
            },
          },
          column: "pushed" as const,
          reasons: [],
        },
      ],
    }),
    buildParityChain: () => ({
      source: "surface-sync" as const,
      repo: "owner/repo",
      mode: "full" as const,
      authority: "issue" as const,
      scope: "all" as const,
      apply: false,
      units: [{ branch: workUnitId, ticket: workUnitId, actions: [] }],
      actions: [],
    }),
  };
}

describe("prx plan session --repo <slug>", () => {
  test("materializes the target worktree at the resolved bare-repo cwd, not process.cwd()", async () => {
    const repoCommonDir = "/scratch/bare/amz_sp_api.git";
    const targetWorktree = mkdtempSync(join(tmpdir(), "prx-plan-session-repo-target-"));
    const materializeCalls: Array<{ workUnitId: string; cwd: string }> = [];
    const resolveCalls: Array<{ workUnitId: string; cwd: string }> = [];

    const exitCode = await runCliDirect(
      ["plan", "session", "GH-5431", "--repo", "amz_sp_api", "--dry-run"],
      { log: () => {}, error: () => {} },
      {
        ...issueBackedDeps("GH-5431"),
        loadRepoInventoryConfig: () => inventoryConfigStub(),
        discoverLocalRepos: () =>
          inventoryWith([bareRepo("amz_sp_api", repoCommonDir, "bdelanghe/amz_sp_api")]),
        materializeWorktree: (workUnitId, cwd) => {
          materializeCalls.push({ workUnitId, cwd });
        },
        resolveWorkUnitCwd: (workUnitId, cwd) => {
          resolveCalls.push({ workUnitId, cwd: cwd ?? "" });
          return targetWorktree;
        },
        findSavedClaudeSession: () => false,
      },
    );

    expect(exitCode).toBe(0);
    expect(materializeCalls).toHaveLength(1);
    expect(materializeCalls[0]).toEqual({ workUnitId: "GH-5431", cwd: repoCommonDir });
    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0]?.cwd).toBe(repoCommonDir);
  });

  test("resolves by owner/name when LocalRepo.name does not match", async () => {
    const repoCommonDir = "/scratch/bare/demo-web.git";
    const targetWorktree = mkdtempSync(join(tmpdir(), "prx-plan-session-repo-owner-"));
    const materializeCalls: Array<{ workUnitId: string; cwd: string }> = [];

    const exitCode = await runCliDirect(
      ["plan", "session", "GH-171", "--repo", "demo/demo-web", "--dry-run"],
      { log: () => {}, error: () => {} },
      {
        ...issueBackedDeps("GH-171"),
        loadRepoInventoryConfig: () => inventoryConfigStub(),
        discoverLocalRepos: () =>
          inventoryWith([bareRepo("demo-web", repoCommonDir, "demo/demo-web")]),
        materializeWorktree: (workUnitId, cwd) => {
          materializeCalls.push({ workUnitId, cwd });
        },
        resolveWorkUnitCwd: () => targetWorktree,
        findSavedClaudeSession: () => false,
      },
    );

    expect(exitCode).toBe(0);
    expect(materializeCalls).toEqual([{ workUnitId: "GH-171", cwd: repoCommonDir }]);
  });

  test("errors with a `prx repo add` hint when the slug is not registered", async () => {
    const errors: string[] = [];

    const exitCode = await runCliDirect(
      ["plan", "session", "GH-5431", "--repo", "not-a-real-slug", "--dry-run"],
      { log: () => {}, error: (line) => errors.push(line) },
      {
        ...issueBackedDeps("GH-5431"),
        loadRepoInventoryConfig: () => inventoryConfigStub(),
        discoverLocalRepos: () => inventoryWith([]),
        materializeWorktree: () => {
          throw new Error("materializeWorktree must not run when slug is unregistered");
        },
        resolveWorkUnitCwd: () => {
          throw new Error("resolveWorkUnitCwd must not run when slug is unregistered");
        },
      },
    );

    expect(exitCode).not.toBe(0);
    expect(errors.join("\n")).toContain("not-a-real-slug");
    expect(errors.join("\n")).toContain("prx repo add");
  });

  test("ambiguous slug surfaces the candidate list", async () => {
    const errors: string[] = [];

    const exitCode = await runCliDirect(
      ["plan", "session", "GH-5431", "--repo", "duplicate", "--dry-run"],
      { log: () => {}, error: (line) => errors.push(line) },
      {
        ...issueBackedDeps("GH-5431"),
        loadRepoInventoryConfig: () => inventoryConfigStub(),
        discoverLocalRepos: () =>
          inventoryWith([
            bareRepo("duplicate", "/bare/a/duplicate.git", "org-a/duplicate"),
            bareRepo("duplicate", "/bare/b/duplicate.git", "org-b/duplicate"),
          ]),
        materializeWorktree: () => {
          throw new Error("materializeWorktree must not run when slug is ambiguous");
        },
      },
    );

    expect(exitCode).not.toBe(0);
    const joined = errors.join("\n");
    expect(joined).toContain("ambiguous");
    expect(joined).toContain("org-a/duplicate");
    expect(joined).toContain("org-b/duplicate");
  });

  test("--repo implies --create: materializeWorktree fires even without an explicit --create flag", async () => {
    const repoCommonDir = "/scratch/bare/amz_sp_api.git";
    const targetWorktree = mkdtempSync(join(tmpdir(), "prx-plan-session-repo-implies-create-"));
    const materializeCalls: string[] = [];

    const exitCode = await runCliDirect(
      ["plan", "session", "GH-5431", "--repo", "amz_sp_api", "--dry-run"],
      { log: () => {}, error: () => {} },
      {
        ...issueBackedDeps("GH-5431"),
        loadRepoInventoryConfig: () => inventoryConfigStub(),
        discoverLocalRepos: () =>
          inventoryWith([bareRepo("amz_sp_api", repoCommonDir, "bdelanghe/amz_sp_api")]),
        materializeWorktree: (workUnitId) => {
          materializeCalls.push(workUnitId);
        },
        resolveWorkUnitCwd: () => targetWorktree,
        findSavedClaudeSession: () => false,
      },
    );

    expect(exitCode).toBe(0);
    // No --create on argv, but --repo still triggers materialization (the
    // whole point: the target worktree must exist before launchCwd resolves).
    expect(materializeCalls).toEqual(["GH-5431"]);
  });
});
