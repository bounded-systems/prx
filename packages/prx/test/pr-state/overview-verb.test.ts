import { describe, expect, test } from "bun:test";

import {
  overviewVerb,
  type OverviewDeps,
  type OverviewOutput,
} from "../../src/pr-state/overview-verb.ts";

// `prx overview` (a.k.a. `repo overview` / `scout overview`) migrated off cli.ts
// to a deps-bearing VerbSpec (ADR docs/prx/cli-decomposition.md). These exercise
// run + render through the verb's OverviewDeps seam (the inventory + status reads
// the legacy CliDeps bag used to inject); routing is covered by the compiled CLI.

const baseInput = {
  slug: null as string | null,
  "repo-path": ".",
  format: "plain" as const,
  "include-diff-stats": true,
};

const richCurrentBranch = {
  number: 10,
  title: "Current branch PR",
  branch: "feature-branch",
  url: "https://example.com/10",
  draft: false,
  checks: "green",
  review: "review_required",
  approvals: 0,
  mergeable: "mergeable",
  worktree: { clean: true, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
  diff: { files: 12, additions: 48, deletions: 9 },
  local: {
    worktreePath: "/repo/feature-branch",
    contractPath: "/repo/feature-branch/.pr/local/pr.json",
    lifecycle: "ready_for_review",
    mode: "ready",
  },
};

const inventoryWithLima = {
  roots: [],
  repos: [
    {
      name: "lima-devshell",
      commonDir: "/bare/io.github/bdelanghe/lima-devshell.git",
      kind: "bare",
      mainWorktree: "/wt/lima-devshell.git/mainx",
      worktrees: [],
      localOnlyBranches: [],
      findings: [],
      remotes: [],
      primaryRemote: {
        name: "origin",
        url: "git@github.com:bdelanghe/lima-devshell.git",
        githubRepo: "bdelanghe/lima-devshell",
      },
      upstreamRemote: null,
    },
  ],
};

const configFixture = { indexPath: "/repo/.prx/repos/index.json" };

/** A deps slice that fails loudly if the inventory path is touched. */
function depsNoInventory(
  overviewStatus: OverviewDeps["overviewStatus"],
): OverviewDeps {
  return {
    loadRepoInventoryConfig: () => {
      throw new Error("inventory must not be consulted without a slug");
    },
    loadRepoInventoryIndex: () => {
      throw new Error("inventory must not be consulted without a slug");
    },
    overviewStatus,
  };
}

const run = (input: typeof baseInput, deps: OverviewDeps): OverviewOutput =>
  overviewVerb.run(input as never, deps) as OverviewOutput;

describe("overview verb", () => {
  test("renders the current-branch summary (no slug)", () => {
    const deps = depsNoInventory(
      () => ({ repo: "owner/repo", currentBranch: richCurrentBranch, createdByYou: [] }) as never,
    );
    const out = run(baseInput, deps);
    expect(out.rendered).toContain("Relevant pull requests in owner/repo");
    expect(out.rendered).toContain("Current branch PR");
    expect(out.rendered).toContain(
      "✓ Checks passing - Review required | mergeable | wt clean | diff 12f +48/-9 | local ready_for_review (ready)",
    );
  });

  test("<slug> resolves via inventory and calls overviewStatus with mainWorktree", () => {
    const calls: Array<{ repoPath: string; includeDiffStats: boolean | undefined }> = [];
    const deps: OverviewDeps = {
      loadRepoInventoryConfig: () => configFixture as never,
      loadRepoInventoryIndex: () => inventoryWithLima as never,
      overviewStatus: (repoPath, includeDiffStats) => {
        calls.push({ repoPath, includeDiffStats });
        return { repo: "bdelanghe/lima-devshell", currentBranch: null, createdByYou: [] } as never;
      },
    };
    const out = run({ ...baseInput, slug: "lima-devshell" }, deps);
    expect(calls).toEqual([{ repoPath: "/wt/lima-devshell.git/mainx", includeDiffStats: true }]);
    expect(out.rendered).toContain("Relevant pull requests in bdelanghe/lima-devshell");
  });

  test("without a slug the inventory is not consulted and repoPath defaults to '.'", () => {
    const calls: Array<{ repoPath: string; includeDiffStats: boolean | undefined }> = [];
    const deps = depsNoInventory((repoPath, includeDiffStats) => {
      calls.push({ repoPath, includeDiffStats });
      return { repo: "owner/repo", currentBranch: null, createdByYou: [] } as never;
    });
    run(baseInput, deps);
    expect(calls).toEqual([{ repoPath: ".", includeDiffStats: true }]);
  });

  test("<unknown-slug> throws the locateRepo not-found error and never probes status", () => {
    const calls: string[] = [];
    const deps: OverviewDeps = {
      loadRepoInventoryConfig: () => configFixture as never,
      loadRepoInventoryIndex: () => inventoryWithLima as never,
      overviewStatus: (repoPath) => {
        calls.push(repoPath);
        return { repo: "owner/repo", currentBranch: null, createdByYou: [] } as never;
      },
    };
    expect(() => run({ ...baseInput, slug: "not-a-real-slug" }, deps)).toThrow(
      "No repo registered with slug 'not-a-real-slug'",
    );
    expect(calls).toEqual([]);
  });

  test("requests diff stats by default", () => {
    const seen: Array<boolean | undefined> = [];
    const deps = depsNoInventory((_repoPath, includeDiffStats) => {
      seen.push(includeDiffStats);
      return { repo: "owner/repo", currentBranch: null, createdByYou: [] } as never;
    });
    run(baseInput, deps);
    expect(seen).toEqual([true]);
  });

  test("omits the duplicate current-branch entry from created-by-you", () => {
    const currentBranch = {
      number: 10,
      title: "Current branch PR",
      branch: "feature-branch",
      url: "https://example.com/10",
      draft: false,
      checks: "green",
      review: "review_required",
      approvals: 0,
      mergeable: "unknown",
      worktree: null,
      diff: { files: 12, additions: 48, deletions: 9 },
      local: null,
    };
    const otherPr = {
      number: 11,
      title: "Other PR",
      branch: "other-branch",
      url: "https://example.com/11",
      draft: true,
      checks: "pending",
      review: "approved",
      approvals: 3,
      mergeable: "unknown",
      worktree: null,
      diff: { files: 3, additions: 7, deletions: 2 },
      local: null,
    };
    const deps = depsNoInventory(
      () =>
        ({
          repo: "owner/repo",
          currentBranch,
          createdByYou: [currentBranch, otherPr],
        }) as never,
    );
    const out = run(baseInput, deps);
    expect(out.rendered.match(/Current branch PR/g)?.length ?? 0).toBe(2);
    expect(out.rendered).toContain("#11  Other PR [other-branch]");
    expect(out.rendered).toContain("- Checks pending - ✓ 3 Approved");
  });

  test("render returns the raw rendered text", () => {
    const out: OverviewOutput = { rendered: "x" };
    expect(overviewVerb.render!(out, baseInput as never)).toBe("x");
  });
});
