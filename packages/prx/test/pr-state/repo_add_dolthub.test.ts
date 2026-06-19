// GH-1703 — runRepoAddDolthub: result-arm coverage, idempotency,
// drift/collision guards, GH-1696 chdir-warning suppression.

import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import {
  filterChdirWarning,
  formatRepoAddDolthub,
  runRepoAddDolthub,
  type AddDolthubDeps,
  type AddDolthubOptions,
  type AddDolthubResult,
} from "../../src/pr-state/repo_add_dolthub.ts";
import {
  writeRepoInventoryIndex,
  type LocalRepo,
  type RepoInventory,
  type RepoInventoryConfig,
} from "../../src/pr-state/repos.ts";
import type { BeadsWorkspaceMode } from "../../src/beads/workspace_mode.ts";

function makeRepo(name: string, overrides: Partial<LocalRepo> = {}): LocalRepo {
  return {
    name,
    commonDir: `/bare/${name}.git`,
    kind: "bare",
    mainWorktree: `/wt/${name}/mainx`,
    worktrees: [
      {
        path: `/wt/${name}/mainx`,
        branch: null,
        current: false,
        kind: "worktree",
      },
    ],
    localOnlyBranches: [],
    findings: [],
    remotes: [],
    primaryRemote: {
      name: "origin",
      url: `git@github.com:bdelanghe/${name}.git`,
      githubRepo: `bdelanghe/${name}`,
    },
    upstreamRemote: null,
    bd_workspace_prefix: name,
    ...overrides,
  };
}

function seedInventory(repos: LocalRepo[]): { config: RepoInventoryConfig; indexPath: string } {
  const root = mkdtempSync(join(tmpdir(), "prx-add-dolthub-"));
  const repoRoot = join(root, "ai-home");
  const indexDir = join(repoRoot, ".prx", "repos");
  mkdirSync(indexDir, { recursive: true });
  const indexPath = join(indexDir, "index.json");
  const inventory: RepoInventory = {
    roots: [],
    repos,
    bareRoot: join(root, "bare"),
    configPath: join(indexDir, "config.json"),
    indexPath,
    generatedAt: "2026-05-14T00:00:00Z",
  };
  writeRepoInventoryIndex(indexPath, inventory);
  return {
    config: {
      repoRoot,
      bareRoot: inventory.bareRoot ?? null,
      roots: [],
      everywhereRoots: [],
      globalConfigPath: null,
      configPath: inventory.configPath ?? null,
      indexPath,
    },
    indexPath,
  };
}

function baseOptions(
  config: RepoInventoryConfig,
  overrides: Partial<AddDolthubOptions> = {},
): AddDolthubOptions {
  return {
    config,
    slug: "ai-home",
    dolthubUserOverride: null,
    nameOverride: null,
    noPush: false,
    dolthubOwnerDefault: null,
    cwd: undefined,
    ...overrides,
  };
}

type Recorded = {
  remoteAdd: Array<{ cwd: string; url: string }>;
  push: Array<{ cwd: string; branch: string }>;
};

function makeDeps(
  overrides: Partial<AddDolthubDeps> = {},
  classify?: BeadsWorkspaceMode,
): { deps: AddDolthubDeps; recorded: Recorded } {
  const recorded: Recorded = { remoteAdd: [], push: [] };
  const deps: AddDolthubDeps = {
    classify: overrides.classify ?? (() => classify ?? { kind: "per_project", doltDir: "/x/dolt" }),
    getGitOrigin: overrides.getGitOrigin ?? ((repo) => `git@github.com:bdelanghe/${repo.name}.git`),
    bdDoltRemoteAdd:
      overrides.bdDoltRemoteAdd ??
      ((cwd, url) => {
        recorded.remoteAdd.push({ cwd, url });
        return { stdout: "", stderr: "", status: 0 };
      }),
    bdDoltPush:
      overrides.bdDoltPush ??
      ((cwd, branch) => {
        recorded.push.push({ cwd, branch });
        return { stdout: "", stderr: "", status: 0 };
      }),
  };
  return { deps, recorded };
}

describe("filterChdirWarning (GH-1696)", () => {
  test("strips the bd CLI-half warning + 'Run: cd ...' hint", () => {
    const raw = [
      "Warning: SQL remote added but CLI remote failed: chdir refused",
      "Run: cd '/Users/dev/wt/ai-home/mainx' && dolt remote add origin https://...",
      "another line preserved",
    ].join("\n");
    const { filtered, suppressed } = filterChdirWarning(raw);
    expect(suppressed).toBe(true);
    expect(filtered).toContain("another line preserved");
    expect(filtered).not.toContain("CLI remote failed");
    expect(filtered).not.toContain("dolt remote add");
  });

  test("leaves unrelated stderr untouched and reports suppressed=false", () => {
    const { filtered, suppressed } = filterChdirWarning("some unrelated noise");
    expect(suppressed).toBe(false);
    expect(filtered).toBe("some unrelated noise");
  });
});

describe("runRepoAddDolthub: refused arms", () => {
  test("refuses when no inventory index is configured", () => {
    const result = runRepoAddDolthub(
      {
        config: {
          repoRoot: null,
          bareRoot: null,
          roots: [],
          everywhereRoots: [],
          globalConfigPath: null,
          configPath: null,
          indexPath: null,
        },
        slug: "ai-home",
        dolthubUserOverride: null,
        nameOverride: null,
        noPush: false,
        dolthubOwnerDefault: null,
      },
      makeDeps().deps,
    );
    expect(result.kind).toBe("refused");
    expect((result as Extract<AddDolthubResult, { kind: "refused" }>).reason).toBe("no-inventory");
  });

  test("refuses with slug-not-found when slug does not resolve", () => {
    const { config } = seedInventory([makeRepo("ai-home")]);
    const { deps } = makeDeps();
    const result = runRepoAddDolthub(baseOptions(config, { slug: "no-such-repo" }), deps);
    expect(result.kind).toBe("refused");
    expect((result as Extract<AddDolthubResult, { kind: "refused" }>).reason).toBe(
      "slug-not-found",
    );
  });

  test("refuses when beads workspace is in 'none' mode", () => {
    const { config } = seedInventory([makeRepo("ai-home")]);
    const { deps } = makeDeps({}, { kind: "none" });
    const result = runRepoAddDolthub(baseOptions(config), deps);
    expect(result.kind).toBe("refused");
    expect((result as Extract<AddDolthubResult, { kind: "refused" }>).reason).toBe(
      "beads-state-none",
    );
  });

  test("refuses when beads workspace is in 'embedded' mode", () => {
    const { config } = seedInventory([makeRepo("ai-home")]);
    const { deps } = makeDeps({}, { kind: "embedded", doltDir: "/x/.dolt" });
    const result = runRepoAddDolthub(baseOptions(config), deps);
    expect(result.kind).toBe("refused");
    expect((result as Extract<AddDolthubResult, { kind: "refused" }>).reason).toBe(
      "beads-state-embedded",
    );
  });

  test("refuses when origin is unset", () => {
    const { config } = seedInventory([makeRepo("ai-home")]);
    const { deps } = makeDeps({ getGitOrigin: () => null });
    const result = runRepoAddDolthub(baseOptions(config), deps);
    expect(result.kind).toBe("refused");
    expect((result as Extract<AddDolthubResult, { kind: "refused" }>).reason).toBe("no-origin");
  });

  test("refuses when --name does not match Dolthub repo-name regex", () => {
    const { config } = seedInventory([makeRepo("ai-home")]);
    const { deps } = makeDeps();
    const result = runRepoAddDolthub(
      baseOptions(config, { nameOverride: "1-leading-digit" }),
      deps,
    );
    expect(result.kind).toBe("refused");
    expect((result as Extract<AddDolthubResult, { kind: "refused" }>).reason).toBe("name-invalid");
  });

  test("refuses with drift when persisted URL ≠ candidate URL", () => {
    const { config } = seedInventory([
      makeRepo("ai-home", {
        dolt_remote: "https://doltremoteapi.dolthub.com/bdelanghe/legacy-name",
      }),
    ]);
    const { deps } = makeDeps();
    const result = runRepoAddDolthub(baseOptions(config), deps);
    expect(result.kind).toBe("refused");
    expect((result as Extract<AddDolthubResult, { kind: "refused" }>).reason).toBe("drift");
  });

  test("refuses on name-collision when another inventory entry owns the candidate URL", () => {
    const { config } = seedInventory([
      makeRepo("ai-home"),
      makeRepo("other", {
        dolt_remote: "https://doltremoteapi.dolthub.com/bdelanghe/ai-home",
      }),
    ]);
    const { deps, recorded } = makeDeps();
    const result = runRepoAddDolthub(baseOptions(config), deps);
    expect(result.kind).toBe("refused");
    expect((result as Extract<AddDolthubResult, { kind: "refused" }>).reason).toBe(
      "name-collision",
    );
    // No bd subprocess invoked on collision.
    expect(recorded.remoteAdd).toEqual([]);
    expect(recorded.push).toEqual([]);
  });
});

describe("runRepoAddDolthub: happy paths", () => {
  test("wired: invokes bd remote add + push, persists dolt_remote on the inventory", () => {
    const { config, indexPath } = seedInventory([makeRepo("ai-home")]);
    const { deps, recorded } = makeDeps();
    const result = runRepoAddDolthub(baseOptions(config), deps);
    expect(result.kind).toBe("wired");
    const wired = result as Extract<AddDolthubResult, { kind: "wired" }>;
    expect(wired.url).toBe("https://doltremoteapi.dolthub.com/bdelanghe/ai-home");
    expect(wired.pushed).toBe(true);
    expect(recorded.remoteAdd).toHaveLength(1);
    expect(recorded.remoteAdd[0]).toEqual({
      cwd: "/wt/ai-home/mainx",
      url: "https://doltremoteapi.dolthub.com/bdelanghe/ai-home",
    });
    expect(recorded.push).toEqual([{ cwd: "/wt/ai-home/mainx", branch: "main" }]);
    const persisted = JSON.parse(readFileSync(indexPath, "utf8")) as RepoInventory;
    expect(persisted.repos[0]!.dolt_remote).toBe(
      "https://doltremoteapi.dolthub.com/bdelanghe/ai-home",
    );
  });

  test("wired (--no-push): skips bd push but still wires the remote", () => {
    const { config } = seedInventory([makeRepo("ai-home")]);
    const { deps, recorded } = makeDeps();
    const result = runRepoAddDolthub(baseOptions(config, { noPush: true }), deps);
    expect(result.kind).toBe("wired");
    expect((result as Extract<AddDolthubResult, { kind: "wired" }>).pushed).toBe(false);
    expect(recorded.remoteAdd).toHaveLength(1);
    expect(recorded.push).toEqual([]);
  });

  test("--name and --dolthub-user override the derived components", () => {
    const { config } = seedInventory([makeRepo("ai-home")]);
    const { deps, recorded } = makeDeps();
    const result = runRepoAddDolthub(
      baseOptions(config, {
        nameOverride: "custom-name",
        dolthubUserOverride: "other-user",
      }),
      deps,
    );
    expect(result.kind).toBe("wired");
    const wired = result as Extract<AddDolthubResult, { kind: "wired" }>;
    expect(wired.url).toBe("https://doltremoteapi.dolthub.com/other-user/custom-name");
    expect(recorded.remoteAdd[0]!.url).toBe(
      "https://doltremoteapi.dolthub.com/other-user/custom-name",
    );
  });

  test("already-wired: short-circuits before any bd subprocess", () => {
    const { config } = seedInventory([
      makeRepo("ai-home", {
        dolt_remote: "https://doltremoteapi.dolthub.com/bdelanghe/ai-home",
      }),
    ]);
    const { deps, recorded } = makeDeps();
    const result = runRepoAddDolthub(baseOptions(config), deps);
    expect(result.kind).toBe("already-wired");
    expect((result as Extract<AddDolthubResult, { kind: "already-wired" }>).url).toBe(
      "https://doltremoteapi.dolthub.com/bdelanghe/ai-home",
    );
    expect(recorded.remoteAdd).toEqual([]);
    expect(recorded.push).toEqual([]);
  });

  test("GH-1696 chdir-warning is suppressed and reported via the result arm", () => {
    const { config } = seedInventory([makeRepo("ai-home")]);
    const noisyStderr = [
      "Warning: SQL remote added but CLI remote failed: chdir refused",
      "Run: cd '/wt/ai-home/mainx' && dolt remote add origin https://example",
    ].join("\n");
    const { deps } = makeDeps({
      bdDoltRemoteAdd: () => ({ stdout: "", stderr: noisyStderr, status: 0 }),
    });
    const result = runRepoAddDolthub(baseOptions(config, { noPush: true }), deps);
    expect(result.kind).toBe("wired");
    const wired = result as Extract<AddDolthubResult, { kind: "wired" }>;
    expect(wired.chdirWarningSuppressed).toBe(true);
    expect(wired.bdStderr).not.toContain("CLI remote failed");
    expect(wired.bdStderr).not.toContain("dolt remote add");
  });
});

describe("formatRepoAddDolthub", () => {
  test("plain wired: includes URL and push status", () => {
    const result: AddDolthubResult = {
      kind: "wired",
      slug: "ai-home",
      url: "https://doltremoteapi.dolthub.com/bdelanghe/ai-home",
      pushed: true,
      chdirWarningSuppressed: false,
      bdStderr: "",
    };
    const out = formatRepoAddDolthub(result, "plain");
    expect(out).toContain("wired ai-home");
    expect(out).toContain("https://doltremoteapi.dolthub.com/bdelanghe/ai-home");
    expect(out).toContain("push: done");
  });

  test("plain wired with suppressed chdir warning surfaces the GH-1696 note", () => {
    const result: AddDolthubResult = {
      kind: "wired",
      slug: "ai-home",
      url: "https://doltremoteapi.dolthub.com/bdelanghe/ai-home",
      pushed: true,
      chdirWarningSuppressed: true,
      bdStderr: "",
    };
    const out = formatRepoAddDolthub(result, "plain");
    expect(out).toContain("GH-1696");
  });

  test("plain already-wired explicitly notes 'no bd subprocess invoked'", () => {
    const result: AddDolthubResult = {
      kind: "already-wired",
      slug: "ai-home",
      url: "https://doltremoteapi.dolthub.com/bdelanghe/ai-home",
    };
    const out = formatRepoAddDolthub(result, "plain");
    expect(out).toContain("already-wired");
    expect(out).toContain("no bd subprocess invoked");
  });

  test("json: returns parseable structure for every arm", () => {
    const result: AddDolthubResult = {
      kind: "refused",
      slug: "ai-home",
      reason: "drift",
      detail: "details",
    };
    const parsed = JSON.parse(formatRepoAddDolthub(result, "json"));
    expect(parsed).toEqual(result);
  });
});
