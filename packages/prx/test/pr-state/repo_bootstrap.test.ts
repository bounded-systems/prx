import { describe, expect, test } from "bun:test";

import {
  formatRepoBootstrap,
  runRepoBootstrap,
  type RepoBootstrapResult,
} from "../../src/pr-state/repo_bootstrap.ts";
import { type RepoInventoryConfig } from "../../src/pr-state/repos.ts";

// GH-1012 retired the bd/beads write plane, leaving `prx repo bootstrap` as a
// verb that can only refuse. GH-1005 made it refuse for the RIGHT reason: the
// inventory / locate / worktree / prefix gates that used to run first could
// only change which refusal came back, and on an externally-added repo the
// no-inventory gate won and sent the operator to `prx repo list` — a command
// that neither creates a per-worktree inventory for an external repo nor
// changes the outcome if it did.

function config(overrides: Partial<RepoInventoryConfig> = {}): RepoInventoryConfig {
  return {
    repoRoot: null,
    configPath: null,
    indexPath: null,
    bareRoot: null,
    everywhereRoots: [],
    ...overrides,
  } as RepoInventoryConfig;
}

function refused(result: RepoBootstrapResult): Extract<RepoBootstrapResult, { kind: "refused" }> {
  expect(result.kind).toBe("refused");
  return result as Extract<RepoBootstrapResult, { kind: "refused" }>;
}

describe("runRepoBootstrap (GH-1005)", () => {
  test("refuses with beads-removed when no inventory is resolvable (the external-repo case)", () => {
    const result = refused(
      runRepoBootstrap({
        config: config({ indexPath: null }),
        slug: null,
        prefixOverride: null,
        shipMetadata: false,
        cwd: "/wt/com.github/OMG-ICFP-FTW/icfp2026/mainx",
      }),
    );

    expect(result.reason).toBe("beads-removed");
    // The dead-end hint the issue reported, gone in both halves.
    expect(result.detail).not.toContain("prx repo list");
    expect(result.detail).not.toContain("index.json");
    expect(result.detail).toContain("GH-1012");
  });

  test("refuses identically on a prx-inventory repo — the answer does not depend on inventory", () => {
    const withInventory = refused(
      runRepoBootstrap({
        config: config({ indexPath: "/repo/.prx/repos/index.json" }),
        slug: "ai-home",
        prefixOverride: null,
        shipMetadata: false,
        cwd: "/repo",
      }),
    );
    const withoutInventory = refused(
      runRepoBootstrap({
        config: config({ indexPath: null }),
        slug: "ai-home",
        prefixOverride: null,
        shipMetadata: false,
        cwd: "/repo",
      }),
    );

    expect(withInventory.reason).toBe("beads-removed");
    expect(withInventory.detail).toBe(withoutInventory.detail);
  });

  test("never reads the inventory it was handed", () => {
    let loadCalls = 0;
    runRepoBootstrap(
      {
        config: config({ indexPath: "/repo/.prx/repos/index.json" }),
        slug: null,
        prefixOverride: null,
        shipMetadata: false,
        cwd: "/repo",
      },
      {
        loadRepoInventoryIndex: (() => {
          loadCalls += 1;
          return null;
        }) as never,
      },
    );

    expect(loadCalls).toBe(0);
  });

  test("echoes the operator's slug back unresolved", () => {
    expect(
      refused(
        runRepoBootstrap({
          config: config(),
          slug: "icfp2026",
          prefixOverride: null,
          shipMetadata: false,
        }),
      ).slug,
    ).toBe("icfp2026");
  });

  test("points at the verb that actually finishes the job", () => {
    const result = refused(
      runRepoBootstrap({
        config: config(),
        slug: null,
        prefixOverride: null,
        shipMetadata: false,
      }),
    );

    expect(result.detail).toContain("prx repo add");
  });

  test("formats as a refusal line in plain, and round-trips in json", () => {
    const result = runRepoBootstrap({
      config: config(),
      slug: "icfp2026",
      prefixOverride: null,
      shipMetadata: false,
    });

    expect(formatRepoBootstrap(result, "plain")).toStartWith("refused (beads-removed): ");
    expect(JSON.parse(formatRepoBootstrap(result, "json"))).toEqual(result);
  });
});
