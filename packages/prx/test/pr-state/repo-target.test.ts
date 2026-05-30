// GH-1689 — unit coverage for `resolveTargetRepoCwd`: the shared slug →
// target-mainx-cwd resolver consumed by plan-session and triage-session.

import { describe, expect, test } from "bun:test";

import { resolveTargetRepoCwd } from "../../src/pr-state/repo-target.ts";
import type {
  LocalRepo,
  RepoInventory,
  RepoInventoryConfig,
} from "../../src/pr-state/repos.ts";
import type { MaterializeResult } from "../../src/pr-state/materialize.ts";

function bareRepo(
  name: string,
  commonDir: string,
  ownerName?: string,
  mainWorktree: string | null = null,
): LocalRepo {
  return {
    name,
    commonDir,
    kind: "bare",
    mainWorktree,
    worktrees: [],
    localOnlyBranches: [],
    findings: [],
    remotes: [],
    primaryRemote: ownerName
      ? { name: "origin", url: `git@github.com:${ownerName}.git`, githubRepo: ownerName }
      : null,
    upstreamRemote: null,
  };
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

function inventoryWith(repos: LocalRepo[]): RepoInventory {
  return { roots: [], repos };
}

describe("resolveTargetRepoCwd (GH-1689)", () => {
  test("returns mainWorktree when present and runs the materialize call", () => {
    const repoCommonDir = "/scratch/bare/foo.git";
    const mainx = "/scratch/wt/foo/mainx";
    const repo = bareRepo("foo", repoCommonDir, "owner/foo", mainx);
    const materializeCalls: Array<{ name: string; cwd?: string | undefined }> = [];

    const result = resolveTargetRepoCwd(
      { slug: "foo", cwd: "/anywhere" },
      {
        loadRepoInventoryConfig: () => inventoryConfigStub(),
        discoverLocalRepos: () => inventoryWith([repo]),
        materializeBareRepo: (opts) => {
          materializeCalls.push({ name: opts.name, cwd: opts.cwd });
          return {
            repo: opts.name,
            barePath: repoCommonDir,
            action: "noop",
            lastFetchedAtMs: 0,
            dryRun: false,
          } satisfies MaterializeResult;
        },
      },
    );

    expect(result.targetCwd).toBe(mainx);
    expect(result.repo.name).toBe("foo");
    expect(materializeCalls).toEqual([{ name: "foo", cwd: "/anywhere" }]);
    expect(result.materialize?.barePath).toBe(repoCommonDir);
  });

  test("falls back to commonDir when mainWorktree is null", () => {
    const repoCommonDir = "/scratch/bare/foo.git";
    const repo = bareRepo("foo", repoCommonDir, "owner/foo", null);

    const result = resolveTargetRepoCwd(
      { slug: "foo", cwd: "/anywhere", skipMaterialize: true },
      {
        loadRepoInventoryConfig: () => inventoryConfigStub(),
        discoverLocalRepos: () => inventoryWith([repo]),
      },
    );

    expect(result.targetCwd).toBe(repoCommonDir);
    expect(result.materialize).toBeNull();
  });

  test("not_registered: error message hints `prx repo add`", () => {
    expect(() =>
      resolveTargetRepoCwd(
        { slug: "nope", cwd: "/anywhere", skipMaterialize: true },
        {
          loadRepoInventoryConfig: () => inventoryConfigStub(),
          discoverLocalRepos: () => inventoryWith([]),
        },
      ),
    ).toThrow(/Repo "nope" is not registered\. Run `prx repo add/);
  });

  test("ambiguous slug: error message lists candidates and asks for owner/name", () => {
    expect(() =>
      resolveTargetRepoCwd(
        { slug: "dup", cwd: "/anywhere", skipMaterialize: true },
        {
          loadRepoInventoryConfig: () => inventoryConfigStub(),
          discoverLocalRepos: () =>
            inventoryWith([
              bareRepo("dup", "/bare/a/dup.git", "org-a/dup"),
              bareRepo("dup", "/bare/b/dup.git", "org-b/dup"),
            ]),
        },
      ),
    ).toThrow(/Repo slug "dup" is ambiguous; candidates: org-a\/dup, org-b\/dup\. Pass the full owner\/name\./);
  });

  test("skipMaterialize: true does not invoke materializeBareRepo", () => {
    const repo = bareRepo("foo", "/scratch/bare/foo.git", "owner/foo", "/scratch/wt/foo/mainx");
    let materializeCount = 0;

    const result = resolveTargetRepoCwd(
      { slug: "foo", cwd: "/anywhere", skipMaterialize: true },
      {
        loadRepoInventoryConfig: () => inventoryConfigStub(),
        discoverLocalRepos: () => inventoryWith([repo]),
        materializeBareRepo: () => {
          materializeCount += 1;
          throw new Error("materializeBareRepo must not be called when skipMaterialize is true");
        },
      },
    );

    expect(materializeCount).toBe(0);
    expect(result.materialize).toBeNull();
    expect(result.targetCwd).toBe("/scratch/wt/foo/mainx");
  });
});
