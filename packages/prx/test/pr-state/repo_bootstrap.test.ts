// GH-1704 — runRepoBootstrap: refusal arms, both happy paths, idempotency,
// auto-chain non-fatality, prefix override.

import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import {
  formatRepoBootstrap,
  runRepoBootstrap,
  type BootstrapEventName,
  type RepoBootstrapDeps,
  type RepoBootstrapOptions,
  type RepoBootstrapResult,
} from "../../src/pr-state/repo_bootstrap.ts";
import {
  writeRepoInventoryIndex,
  type LocalRepo,
  type RepoInventory,
  type RepoInventoryConfig,
} from "../../src/pr-state/repos.ts";
import type { BeadsWorkspaceMode } from "../../src/beads/workspace_mode.ts";
import type {
  AddDolthubRefusalReason,
  AddDolthubResult,
} from "../../src/pr-state/repo_add_dolthub.ts";
import type { SpawnCaptureResult } from "@bounded-systems/proc";

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
    ...overrides,
  };
}

function seedInventory(repos: LocalRepo[]): {
  config: RepoInventoryConfig;
  indexPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "prx-bootstrap-"));
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
  overrides: Partial<RepoBootstrapOptions> = {},
): RepoBootstrapOptions {
  return {
    config,
    slug: "ai-home",
    prefixOverride: null,
    shipMetadata: false,
    cwd: undefined,
    ...overrides,
  };
}

type Recorded = {
  bdInit: Array<{
    cmd: readonly string[];
    cwd: string | undefined;
    env: NodeJS.ProcessEnv | undefined;
  }>;
  git: Array<{ cmd: string[]; cwd: string | undefined }>;
  events: Array<{
    event: BootstrapEventName;
    repo?: string;
    details?: Record<string, unknown>;
  }>;
  cleanupCalls: string[];
};

function makeDeps(
  classifyMode: BeadsWorkspaceMode = { kind: "none" },
  overrides: Partial<RepoBootstrapDeps> & {
    addDolthubResult?: AddDolthubResult;
  } = {},
): { deps: RepoBootstrapDeps; recorded: Recorded } {
  const recorded: Recorded = { bdInit: [], git: [], events: [], cleanupCalls: [] };
  // Track classify calls so post-init "re-classify" can flip to per_project.
  let classifyCount = 0;
  const defaultClassify = (_repo: LocalRepo): BeadsWorkspaceMode => {
    classifyCount += 1;
    // First call is the pre-init gate; later calls happen after bd init ran,
    // so report per_project (matches the post-init disk shape).
    if (classifyCount > 1 && classifyMode.kind === "none") {
      return { kind: "per_project", doltDir: "/wt/ai-home/mainx/.beads/dolt" };
    }
    return classifyMode;
  };
  const deps: RepoBootstrapDeps = {
    runner:
      overrides.runner ??
      ((cmd, options) => {
        recorded.git.push({ cmd: [...cmd], cwd: options?.cwd });
        return { stdout: "", stderr: "", status: 0 };
      }),
    classify: overrides.classify ?? defaultClassify,
    bdInitRunner:
      overrides.bdInitRunner ??
      ((cmd, options): SpawnCaptureResult => {
        recorded.bdInit.push({ cmd, cwd: options?.cwd, env: options?.env });
        return { status: 0, signal: null, stdout: "", stderr: "" };
      }),
    tempHomeFactory: overrides.tempHomeFactory ?? ((slug) => `/tmp/prx-bd-init-${slug}-fixed`),
    legacyHomeProbe: overrides.legacyHomeProbe ?? (() => false),
    recordEvent:
      overrides.recordEvent ??
      ((event, opts) => {
        recorded.events.push({
          event,
          ...(opts?.repo ? { repo: opts.repo } : {}),
          ...(opts?.details ? { details: opts.details } : {}),
        });
      }),
    isMainProtected: overrides.isMainProtected ?? (() => true),
    gitStatusClean: overrides.gitStatusClean ?? (() => true),
    runAddDolthub:
      overrides.runAddDolthub ??
      ((): AddDolthubResult =>
        overrides.addDolthubResult ?? {
          kind: "wired",
          slug: "ai-home",
          url: "https://doltremoteapi.dolthub.com/bdelanghe/ai-home",
          pushed: true,
          chdirWarningSuppressed: false,
          bdStderr: "",
        }),
    dolthubOwnerDefault: overrides.dolthubOwnerDefault ?? null,
  };
  return { deps, recorded };
}

describe("runRepoBootstrap: refused arms", () => {
  test("refuses when no inventory index is configured", () => {
    const result = runRepoBootstrap(
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
        prefixOverride: null,
        shipMetadata: false,
      },
      makeDeps().deps,
    );
    expect(result.kind).toBe("refused");
    expect((result as Extract<RepoBootstrapResult, { kind: "refused" }>).reason).toBe(
      "no-inventory",
    );
  });

  test("refuses with slug-not-found when slug does not resolve", () => {
    const { config } = seedInventory([makeRepo("ai-home")]);
    const { deps } = makeDeps();
    const result = runRepoBootstrap(baseOptions(config, { slug: "no-such-repo" }), deps);
    expect(result.kind).toBe("refused");
    expect((result as Extract<RepoBootstrapResult, { kind: "refused" }>).reason).toBe(
      "slug-not-found",
    );
  });

  test("refuses with no-worktree when repo has no attached worktree", () => {
    const { config } = seedInventory([makeRepo("ai-home", { mainWorktree: null, worktrees: [] })]);
    const { deps } = makeDeps();
    const result = runRepoBootstrap(baseOptions(config), deps);
    expect(result.kind).toBe("refused");
    expect((result as Extract<RepoBootstrapResult, { kind: "refused" }>).reason).toBe(
      "no-worktree",
    );
  });

  test.each([
    ["embedded", { kind: "embedded", doltDir: "/x/.dolt" }],
    ["per_project", { kind: "per_project", doltDir: "/x/dolt" }],
    ["shared_server", { kind: "shared_server", sharedDir: "/x/shared" }],
    [
      "ambiguous",
      { kind: "ambiguous", details: ".beads/ has neither dolt/ nor embeddeddolt/<ws>/.dolt" },
    ],
  ] as Array<
    [string, BeadsWorkspaceMode]
  >)("refuses with beads-already-present when classify reports %s", (_label, mode) => {
    const { config } = seedInventory([makeRepo("ai-home")]);
    // Force the classifier to return the same non-none mode on every call.
    // For per_project we still need to ensure the inventory's prefix doesn't
    // match (otherwise it'd flip to already-bootstrapped).
    const { deps } = makeDeps(mode, { classify: () => mode });
    const result = runRepoBootstrap(baseOptions(config), deps);
    expect(result.kind).toBe("refused");
    expect((result as Extract<RepoBootstrapResult, { kind: "refused" }>).reason).toBe(
      "beads-already-present",
    );
  });

  test("refuses with prefix-invalid when --prefix does not match the regex", () => {
    const { config } = seedInventory([makeRepo("ai-home")]);
    const { deps } = makeDeps();
    const result = runRepoBootstrap(baseOptions(config, { prefixOverride: "1bad-prefix" }), deps);
    expect(result.kind).toBe("refused");
    expect((result as Extract<RepoBootstrapResult, { kind: "refused" }>).reason).toBe(
      "prefix-invalid",
    );
  });

  test("refuses with protected-branch-no-pr when main isn't protected (--ship-metadata)", () => {
    const { config } = seedInventory([makeRepo("ai-home")]);
    const { deps } = makeDeps({ kind: "none" }, { isMainProtected: () => false });
    const result = runRepoBootstrap(baseOptions(config, { shipMetadata: true }), deps);
    expect(result.kind).toBe("refused");
    expect((result as Extract<RepoBootstrapResult, { kind: "refused" }>).reason).toBe(
      "protected-branch-no-pr",
    );
  });

  test("refuses with git-dirty when working tree is dirty (--ship-metadata)", () => {
    const { config } = seedInventory([makeRepo("ai-home")]);
    const { deps } = makeDeps({ kind: "none" }, { gitStatusClean: () => false });
    const result = runRepoBootstrap(baseOptions(config, { shipMetadata: true }), deps);
    expect(result.kind).toBe("refused");
    expect((result as Extract<RepoBootstrapResult, { kind: "refused" }>).reason).toBe("git-dirty");
  });
});

describe("runRepoBootstrap: happy paths", () => {
  test("stealth default: bd init (per-project) with --stealth, inventory prefix set, no git ops, auto-chain wires dolthub", () => {
    const { config, indexPath } = seedInventory([makeRepo("ai-home")]);
    const { deps, recorded } = makeDeps();
    const result = runRepoBootstrap(baseOptions(config), deps);

    expect(result.kind).toBe("bootstrapped");
    const ok = result as Extract<RepoBootstrapResult, { kind: "bootstrapped" }>;
    expect(ok.slug).toBe("ai-home");
    expect(ok.prefix).toBe("ai-home");
    expect(ok.shipped).toBe(false);
    expect(ok.pr).toBeUndefined();
    expect(ok.dolthub).toEqual({
      wired: true,
      url: "https://doltremoteapi.dolthub.com/bdelanghe/ai-home",
    });

    // 2 calls: bd init, then the GH-1935 post-init `bd config set dolt.auto-push false`.
    expect(recorded.bdInit).toHaveLength(2);
    // Per-project mode: no `--shared-server` flag.
    expect(recorded.bdInit[0]!.cmd).toEqual([
      "bd",
      "init",
      "--non-interactive",
      "--prefix=ai-home",
      "--stealth",
    ]);
    expect(recorded.bdInit[0]!.cwd).toBe("/wt/ai-home/mainx");
    // GH-1935 — post-init disables dolt.auto-push to avoid the 30s timeout
    // when the Hosted Dolt remote is unreachable. See src/pr-state/repo_bootstrap.ts.
    expect(recorded.bdInit[1]!.cmd).toEqual(["bd", "config", "set", "dolt.auto-push", "false"]);
    expect(recorded.bdInit[1]!.cwd).toBe("/wt/ai-home/mainx");
    // No git/gh ops in stealth mode.
    expect(recorded.git).toEqual([]);

    const persisted = JSON.parse(readFileSync(indexPath, "utf8")) as RepoInventory;
    expect(persisted.repos[0]!.bd_workspace_prefix).toBe("ai-home");
  });

  test("--ship-metadata: emits bd init WITHOUT --stealth, creates side branch, commits, pushes, opens draft PR", () => {
    const { config } = seedInventory([makeRepo("ai-home")]);
    const gitCalls: string[][] = [];
    const ghPrUrl = "https://github.com/bdelanghe/ai-home/pull/42";
    const runner = (cmd: readonly string[], _opts?: { cwd?: string; check?: boolean }) => {
      gitCalls.push([...cmd]);
      if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "create") {
        return { stdout: `${ghPrUrl}\n`, stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 0 };
    };
    const { deps, recorded } = makeDeps({ kind: "none" }, { runner });

    const result = runRepoBootstrap(baseOptions(config, { shipMetadata: true }), deps);
    expect(result.kind).toBe("bootstrapped");
    const ok = result as Extract<RepoBootstrapResult, { kind: "bootstrapped" }>;
    expect(ok.shipped).toBe(true);
    expect(ok.pr).toEqual({ url: ghPrUrl, number: 42 });

    // bd init runs WITHOUT --stealth so the bd scaffolding is in the commit.
    expect(recorded.bdInit[0]!.cmd).toEqual([
      "bd",
      "init",
      "--non-interactive",
      "--prefix=ai-home",
    ]);

    // Branch checkout, add, commit, push, gh pr create.
    expect(gitCalls).toEqual([
      ["git", "-C", "/wt/ai-home/mainx", "checkout", "-b", "bootstrap/ai-home-beads-metadata"],
      ["git", "-C", "/wt/ai-home/mainx", "add", ".beads/metadata.json"],
      [
        "git",
        "-C",
        "/wt/ai-home/mainx",
        "commit",
        "-m",
        "chore(beads): bootstrap ai-home metadata",
      ],
      [
        "git",
        "-C",
        "/wt/ai-home/mainx",
        "push",
        "-u",
        "origin",
        "bootstrap/ai-home-beads-metadata",
      ],
      [
        "gh",
        "pr",
        "create",
        "--draft",
        "--base",
        "main",
        "--head",
        "bootstrap/ai-home-beads-metadata",
        "--title",
        "chore(beads): bootstrap ai-home metadata",
        "--body",
        "Generated by `prx repo bootstrap --ship-metadata` (GH-1704).",
      ],
    ]);
  });

  test("--prefix override: uses operator-supplied prefix verbatim", () => {
    const { config, indexPath } = seedInventory([makeRepo("ai-home")]);
    const { deps, recorded } = makeDeps();
    const result = runRepoBootstrap(baseOptions(config, { prefixOverride: "custom-prefix" }), deps);
    expect(result.kind).toBe("bootstrapped");
    expect((result as Extract<RepoBootstrapResult, { kind: "bootstrapped" }>).prefix).toBe(
      "custom-prefix",
    );
    expect(recorded.bdInit[0]!.cmd).toContain("--prefix=custom-prefix");
    const persisted = JSON.parse(readFileSync(indexPath, "utf8")) as RepoInventory;
    expect(persisted.repos[0]!.bd_workspace_prefix).toBe("custom-prefix");
  });
});

describe("runRepoBootstrap: idempotency", () => {
  test("second run on already-bootstrapped repo returns already-bootstrapped without side effects", () => {
    const { config } = seedInventory([makeRepo("ai-home", { bd_workspace_prefix: "ai-home" })]);
    const perProjectMode: BeadsWorkspaceMode = {
      kind: "per_project",
      doltDir: "/wt/ai-home/mainx/.beads/dolt",
    };
    const { deps, recorded } = makeDeps(perProjectMode, {
      classify: () => perProjectMode,
    });
    const result = runRepoBootstrap(baseOptions(config), deps);
    expect(result.kind).toBe("already-bootstrapped");
    const ok = result as Extract<RepoBootstrapResult, { kind: "already-bootstrapped" }>;
    expect(ok.slug).toBe("ai-home");
    expect(ok.prefix).toBe("ai-home");
    expect(ok.doltDir).toBe("/wt/ai-home/mainx/.beads/dolt");
    // No bd init / git ops on idempotent re-run.
    expect(recorded.bdInit).toEqual([]);
    expect(recorded.git).toEqual([]);
  });
});

describe("runRepoBootstrap: auto-chain non-fatality", () => {
  test("chained refusal (no-origin) reported as dolthub.skipped, bootstrap still succeeds", () => {
    const { config } = seedInventory([makeRepo("ai-home")]);
    const { deps } = makeDeps(
      { kind: "none" },
      {
        addDolthubResult: {
          kind: "refused",
          slug: "ai-home",
          reason: "no-origin" as AddDolthubRefusalReason,
          detail: "no git origin set",
        },
      },
    );
    const result = runRepoBootstrap(baseOptions(config), deps);
    expect(result.kind).toBe("bootstrapped");
    const ok = result as Extract<RepoBootstrapResult, { kind: "bootstrapped" }>;
    expect(ok.dolthub).toEqual({ skipped: true, reason: "no-origin" });
  });

  test("chained wired arm reported as dolthub.wired", () => {
    const { config } = seedInventory([makeRepo("ai-home")]);
    const wiredUrl = "https://doltremoteapi.dolthub.com/bdelanghe/ai-home";
    const { deps } = makeDeps(
      { kind: "none" },
      {
        addDolthubResult: {
          kind: "wired",
          slug: "ai-home",
          url: wiredUrl,
          pushed: true,
          chdirWarningSuppressed: false,
          bdStderr: "",
        },
      },
    );
    const result = runRepoBootstrap(baseOptions(config), deps);
    expect(result.kind).toBe("bootstrapped");
    const ok = result as Extract<RepoBootstrapResult, { kind: "bootstrapped" }>;
    expect(ok.dolthub).toEqual({ wired: true, url: wiredUrl });
  });

  test("name-collision refusal reported as dolthub.skipped, bootstrap still succeeds", () => {
    const { config } = seedInventory([makeRepo("ai-home")]);
    const { deps } = makeDeps(
      { kind: "none" },
      {
        addDolthubResult: {
          kind: "refused",
          slug: "ai-home",
          reason: "name-collision" as AddDolthubRefusalReason,
          detail: "URL already claimed",
        },
      },
    );
    const result = runRepoBootstrap(baseOptions(config), deps);
    expect(result.kind).toBe("bootstrapped");
    expect((result as Extract<RepoBootstrapResult, { kind: "bootstrapped" }>).dolthub).toEqual({
      skipped: true,
      reason: "name-collision",
    });
  });
});

describe("runRepoBootstrap: GH-1750 HOME-isolation", () => {
  test("bd init runs with HOME overridden to the tempHomeFactory's tempdir", () => {
    const { config } = seedInventory([makeRepo("ai-home")]);
    const tempHome = "/tmp/prx-bd-init-ai-home-fixed";
    const { deps, recorded } = makeDeps({ kind: "none" }, { tempHomeFactory: () => tempHome });
    const result = runRepoBootstrap(baseOptions(config), deps);
    expect(result.kind).toBe("bootstrapped");
    // 2 calls: bd init (with HOME override), then `bd config set dolt.auto-push false` (no override).
    expect(recorded.bdInit).toHaveLength(2);
    expect(recorded.bdInit[0]!.env).toBeDefined();
    expect(recorded.bdInit[0]!.env!.HOME).toBe(tempHome);
  });

  test("legacy home present → emits BD_BOOTSTRAP_LEGACY_HOME_DETECTED in the documented order", () => {
    const { config } = seedInventory([makeRepo("ai-home")]);
    const { deps, recorded } = makeDeps({ kind: "none" }, { legacyHomeProbe: () => true });
    const result = runRepoBootstrap(baseOptions(config), deps);
    expect(result.kind).toBe("bootstrapped");
    const ok = result as Extract<RepoBootstrapResult, { kind: "bootstrapped" }>;
    expect(ok.events).toEqual([
      "BD_BOOTSTRAP_STARTED",
      "BD_BOOTSTRAP_LEGACY_HOME_DETECTED",
      "BD_BOOTSTRAP_LEGACY_HOME_ISOLATED",
      "BD_BOOTSTRAP_INIT_COMPLETED",
      "BD_BOOTSTRAP_AUTO_PUSH_DISABLED",
      "BD_BOOTSTRAP_INDEX_UPDATED",
      "BD_BOOTSTRAP_COMPLETED",
    ]);
    const names = recorded.events.map((e) => e.event);
    expect(names).toEqual(ok.events);
  });

  test("legacy home absent → BD_BOOTSTRAP_LEGACY_HOME_DETECTED is suppressed; isolation still emits", () => {
    const { config } = seedInventory([makeRepo("ai-home")]);
    const { deps } = makeDeps({ kind: "none" }, { legacyHomeProbe: () => false });
    const result = runRepoBootstrap(baseOptions(config), deps);
    expect(result.kind).toBe("bootstrapped");
    const ok = result as Extract<RepoBootstrapResult, { kind: "bootstrapped" }>;
    expect(ok.events).not.toContain("BD_BOOTSTRAP_LEGACY_HOME_DETECTED");
    expect(ok.events).toContain("BD_BOOTSTRAP_LEGACY_HOME_ISOLATED");
    expect(ok.events).toContain("BD_BOOTSTRAP_COMPLETED");
  });

  test("legacy-HOME refusal: bd's stderr contains 'Found existing Dolt database' only → bd-init-legacy-home-blocks-init", () => {
    const { config } = seedInventory([makeRepo("ai-home")]);
    const tempHome = "/tmp/prx-bd-init-ai-home-stuck";
    const { deps, recorded } = makeDeps(
      { kind: "none" },
      {
        tempHomeFactory: () => tempHome,
        bdInitRunner: (cmd, options): SpawnCaptureResult => {
          recorded.bdInit.push({ cmd, cwd: options?.cwd, env: options?.env });
          return {
            status: 1,
            signal: null,
            stdout: "",
            stderr:
              "⚠ Found existing Dolt database: /Users/dev/.local/share/beads-home/embeddeddolt/beads",
          };
        },
      },
    );
    const result = runRepoBootstrap(baseOptions(config), deps);
    expect(result.kind).toBe("refused");
    const refused = result as Extract<RepoBootstrapResult, { kind: "refused" }>;
    expect(refused.reason).toBe("bd-init-legacy-home-blocks-init");
    expect(refused.detail).toContain(`HOME isolated to ${tempHome}`);
    expect(refused.detail).toContain("gastownhall/beads");
    const failedEvent = recorded.events.find((e) => e.event === "BD_BOOTSTRAP_FAILED");
    expect(failedEvent).toBeDefined();
    expect(failedEvent!.details).toMatchObject({
      legacyHomeStillBlocked: true,
      tempHome,
    });
    // Completion event NOT emitted on the refusal arm.
    expect(recorded.events.some((e) => e.event === "BD_BOOTSTRAP_COMPLETED")).toBe(false);
  });

  test("GH-2017 — workspace-already-initialized refusal: bd's auto-discovery hits an existing .beads/dolt → bd-init-workspace-already-initialized; no mv advice", () => {
    const { config } = seedInventory([makeRepo("ai-home")]);
    const tempHome = "/tmp/prx-bd-init-ai-home-workspace-init";
    const { deps, recorded } = makeDeps(
      { kind: "none" },
      {
        tempHomeFactory: () => tempHome,
        bdInitRunner: (cmd, options): SpawnCaptureResult => {
          recorded.bdInit.push({ cmd, cwd: options?.cwd, env: options?.env });
          return {
            status: 1,
            signal: null,
            stdout: "",
            stderr:
              "⚠ Found existing Dolt database: dolt server at 127.0.0.1:54321\nThis workspace is already initialized.",
          };
        },
      },
    );
    const result = runRepoBootstrap(baseOptions(config), deps);
    expect(result.kind).toBe("refused");
    const refused = result as Extract<RepoBootstrapResult, { kind: "refused" }>;
    expect(refused.reason).toBe("bd-init-workspace-already-initialized");
    expect(refused.detail).toContain("bd info");
    expect(refused.detail).toContain("prx repo backfill");
    expect(refused.detail).not.toContain("mv ~/.local/share/beads-home");
    const failedEvent = recorded.events.find((e) => e.event === "BD_BOOTSTRAP_FAILED");
    expect(failedEvent).toBeDefined();
    expect(failedEvent!.details).toMatchObject({
      legacyHomeStillBlocked: false,
      tempHome,
    });
    expect(recorded.events.some((e) => e.event === "BD_BOOTSTRAP_COMPLETED")).toBe(false);
  });

  test("tempdir lifecycle: created on success path, factory call observed; factory is invoked exactly once", () => {
    const { config } = seedInventory([makeRepo("ai-home")]);
    let factoryCalls = 0;
    const { deps } = makeDeps(
      { kind: "none" },
      {
        tempHomeFactory: (slug) => {
          factoryCalls += 1;
          return `/tmp/prx-bd-init-${slug}-${factoryCalls}`;
        },
      },
    );
    const result = runRepoBootstrap(baseOptions(config), deps);
    expect(result.kind).toBe("bootstrapped");
    expect(factoryCalls).toBe(1);
  });

  test("BdInitOptions.homeOverride propagates HOME via the runner env", () => {
    // Inline unit test for the init.ts seam: assert that runBdInit forwards
    // homeOverride into the runner's `env.HOME`. Mirrors the equivalent arm
    // exercised through runRepoBootstrap above, but isolated to the
    // primitive so the seam stays directly covered.
    return import("../../src/beads/init.ts").then(({ runBdInit }) => {
      let observedEnv: NodeJS.ProcessEnv | undefined;
      const result = runBdInit(
        {
          prefix: "ai-home",
          stealth: true,
          cwd: "/wt/ai-home/mainx",
          homeOverride: "/tmp/prx-bd-init-direct",
        },
        (_cmd, options): SpawnCaptureResult => {
          observedEnv = options?.env;
          return { status: 0, signal: null, stdout: "", stderr: "" };
        },
      );
      expect(result.ok).toBe(true);
      expect(observedEnv).toBeDefined();
      expect(observedEnv!.HOME).toBe("/tmp/prx-bd-init-direct");
    });
  });
});

describe("formatRepoBootstrap", () => {
  test("plain bootstrapped: shows prefix, mode, ship-metadata status, dolthub outcome", () => {
    const result: RepoBootstrapResult = {
      kind: "bootstrapped",
      slug: "ai-home",
      prefix: "ai-home",
      doltDir: "/wt/ai-home/mainx/.beads/dolt",
      shipped: false,
      dolthub: { wired: true, url: "https://doltremoteapi.dolthub.com/bdelanghe/ai-home" },
      events: [],
    };
    const out = formatRepoBootstrap(result, "plain");
    expect(out).toContain("bootstrapped ai-home");
    expect(out).toContain("prefix=ai-home");
    expect(out).toContain("mode: per-project");
    expect(out).toContain("stealth");
    expect(out).toContain("dolthub: wired → https://doltremoteapi.dolthub.com/bdelanghe/ai-home");
  });

  test("plain bootstrapped: doesn't claim per-project when bd actually landed embedded mode", () => {
    // Regression: the formatter used to hardcode "mode: per-project" even when
    // doltDir was null (bd's actual default is embedded mode — see
    // workspace_mode.ts's classifyBeadsWorkspaceForRepo). Confirmed live on
    // gh-project-room: bootstrap succeeded, .beads/embeddeddolt/ landed, yet
    // the old text said "per-project" regardless.
    const result: RepoBootstrapResult = {
      kind: "bootstrapped",
      slug: "gh-project-room",
      prefix: "gh-project-room",
      doltDir: null,
      shipped: false,
      dolthub: { skipped: true, reason: "beads-state-none" },
      events: [],
    };
    const out = formatRepoBootstrap(result, "plain");
    expect(out).not.toContain("mode: per-project");
    expect(out).toContain("mode: non-per-project");
  });

  test("plain bootstrapped: surfaces PR url when shipped", () => {
    const result: RepoBootstrapResult = {
      kind: "bootstrapped",
      slug: "ai-home",
      prefix: "ai-home",
      doltDir: null,
      shipped: true,
      pr: { url: "https://github.com/bdelanghe/ai-home/pull/42", number: 42 },
      dolthub: { wired: true, url: "https://doltremoteapi.dolthub.com/bdelanghe/ai-home" },
      events: [],
    };
    const out = formatRepoBootstrap(result, "plain");
    expect(out).toContain("ship-metadata: yes");
    expect(out).toContain("pr: https://github.com/bdelanghe/ai-home/pull/42");
  });

  test("plain already-bootstrapped includes prefix and doltDir", () => {
    const result: RepoBootstrapResult = {
      kind: "already-bootstrapped",
      slug: "ai-home",
      prefix: "ai-home",
      doltDir: "/wt/ai-home/mainx/.beads/dolt",
    };
    const out = formatRepoBootstrap(result, "plain");
    expect(out).toContain("already-bootstrapped ai-home");
    expect(out).toContain("prefix=ai-home");
    expect(out).toContain("/wt/ai-home/mainx/.beads/dolt");
  });

  test("json: returns parseable structure for every arm", () => {
    const result: RepoBootstrapResult = {
      kind: "refused",
      slug: "ai-home",
      reason: "git-dirty",
      detail: "working tree dirty",
    };
    const parsed = JSON.parse(formatRepoBootstrap(result, "json"));
    expect(parsed).toEqual(result);
  });
});

// GH-1935 — post-init `bd config set dolt.auto-push false` so new worktrees
// don't inherit the bd-default `auto-push: true` that blocks every bd write
// on a 30s timeout when the Hosted Dolt remote is unreachable. The step is
// non-fatal: bootstrap proceeds even if the config-set call fails.
describe("runRepoBootstrap: GH-1935 dolt.auto-push disable", () => {
  test("happy path: BD_BOOTSTRAP_AUTO_PUSH_DISABLED event emits between INIT_COMPLETED and INDEX_UPDATED", () => {
    const { config } = seedInventory([makeRepo("ai-home")]);
    const { deps, recorded } = makeDeps();
    const result = runRepoBootstrap(baseOptions(config), deps);
    expect(result.kind).toBe("bootstrapped");
    const ok = result as Extract<RepoBootstrapResult, { kind: "bootstrapped" }>;
    const names = recorded.events.map((e) => e.event);
    const initIdx = names.indexOf("BD_BOOTSTRAP_INIT_COMPLETED");
    const autoIdx = names.indexOf("BD_BOOTSTRAP_AUTO_PUSH_DISABLED");
    const idxIdx = names.indexOf("BD_BOOTSTRAP_INDEX_UPDATED");
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(autoIdx).toBe(initIdx + 1);
    expect(idxIdx).toBe(autoIdx + 1);
    expect(ok.events).toContain("BD_BOOTSTRAP_AUTO_PUSH_DISABLED");
    expect(ok.events).not.toContain("BD_BOOTSTRAP_AUTO_PUSH_DISABLE_FAILED");
  });

  test("failure path: bdInitRunner errors on config-set → bootstrap still succeeds, DISABLE_FAILED event carries detail", () => {
    const { config } = seedInventory([makeRepo("ai-home")]);
    const recorded: {
      bdInit: Array<{
        cmd: readonly string[];
        cwd?: string | undefined;
        env?: NodeJS.ProcessEnv | undefined;
      }>;
      events: Array<{ event: BootstrapEventName; details?: Record<string, unknown> }>;
    } = { bdInit: [], events: [] };
    const { deps } = makeDeps(
      { kind: "none" },
      {
        bdInitRunner: (cmd, options): SpawnCaptureResult => {
          recorded.bdInit.push({ cmd, cwd: options?.cwd, env: options?.env });
          // Second call is the auto-push config-set; fail it. First call (bd init) succeeds.
          if (cmd[1] === "config" && cmd[2] === "set" && cmd[3] === "dolt.auto-push") {
            return {
              status: 1,
              signal: null,
              stdout: "",
              stderr: "Error setting config: no config.yaml found",
            };
          }
          return { status: 0, signal: null, stdout: "", stderr: "" };
        },
        recordEvent: (event, opts) => {
          recorded.events.push({
            event: event as BootstrapEventName,
            ...(opts?.details ? { details: opts.details } : {}),
          });
        },
      },
    );
    const result = runRepoBootstrap(baseOptions(config), deps);
    expect(result.kind).toBe("bootstrapped");
    const failedEvent = recorded.events.find(
      (e) => e.event === "BD_BOOTSTRAP_AUTO_PUSH_DISABLE_FAILED",
    );
    expect(failedEvent).toBeDefined();
    expect(failedEvent!.details).toMatchObject({
      detail: "Error setting config: no config.yaml found",
    });
    // Disabled event NOT emitted on the failure arm.
    expect(recorded.events.some((e) => e.event === "BD_BOOTSTRAP_AUTO_PUSH_DISABLED")).toBe(false);
    // Bootstrap still completes — failure is non-fatal.
    expect(recorded.events.some((e) => e.event === "BD_BOOTSTRAP_COMPLETED")).toBe(true);
  });
});
