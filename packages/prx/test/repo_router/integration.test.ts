// GH-1659 — `repo_router` integration: end-to-end roundtrip against a
// real tmpdir `.prx/repos/index.json` with two `LocalRepo` entries
// (`ai-home` local, `demo-repo` foreign). Asserts the
// acceptance bullet — "a foreign-prefixed BD- long-id → bare clone →
// re-dispatched session reaches the foreign bd workspace" — via the
// orchestrator's return value (the seam GH-1661 will consume).
//
// `materializeRepo` is stubbed; the live wiring lands in GH-1660. The
// integration surface here is "the router routes the right (repo,
// barePath) tuple at the orchestrator's edge", not the clone op itself.
//
// Catalog assertion also lives here so the acceptance bullet ("`prx
// actors --scope workflow` shows repo_router with its emits/accepts")
// is pinned by a test.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { runRepoRouter } from "../../src/repo_router/index.ts";
import {
  dispatchFromArgvWithRouting,
  type DispatchFromArgvRoutingDeps,
} from "../../src/pr-state/session-entry/dispatch.ts";
import {
  resetSessionEntryStderr,
  setSessionEntryStderrSink,
} from "../../src/machine/machines/session-entry.ts";
import {
  loadRepoInventoryConfig,
  loadRepoInventoryIndex,
  localWorkspacePrefixForCwd,
  type RepoRunner,
} from "../../src/pr-state/repos.ts";
import { actorsForScope, eventOwnerMap, toolActorCatalog } from "../../src/machine/actors.ts";

type IndexShape = {
  roots: string[];
  repos: Array<{
    name: string;
    commonDir: string;
    kind: "bare" | "standard";
    mainWorktree: string | null;
    worktrees: Array<{
      path: string;
      branch: string | null;
      current: boolean;
      kind: "standard" | "worktree";
    }>;
    localOnlyBranches: string[];
    findings: unknown[];
    remotes: unknown[];
    primaryRemote: unknown;
    upstreamRemote: unknown;
    bd_workspace_prefix?: string;
  }>;
};

function fixture(): {
  root: string;
  aiHomeWt: string;
  spdBare: string;
  runner: RepoRunner;
} {
  const root = mkdtempSync(join(tmpdir(), "gh-1659-repo-router-"));
  const aiHomeBare = join(root, "bare", "ai-home.git");
  const spdBare = join(root, "bare", "demo-repo.git");
  const aiHomeWt = join(root, "wt", "ai-home", "main");

  for (const path of [aiHomeBare, spdBare, aiHomeWt]) {
    mkdirSync(path, { recursive: true });
  }

  const indexDir = join(root, ".prx", "repos");
  mkdirSync(indexDir, { recursive: true });
  const index: IndexShape = {
    roots: [root],
    repos: [
      {
        name: "ai-home",
        commonDir: aiHomeBare,
        kind: "bare",
        mainWorktree: null,
        worktrees: [{ path: aiHomeWt, branch: "main", current: false, kind: "worktree" }],
        localOnlyBranches: [],
        findings: [],
        remotes: [],
        primaryRemote: null,
        upstreamRemote: null,
        bd_workspace_prefix: "ai-home",
      },
      {
        name: "demo-repo",
        commonDir: spdBare,
        kind: "bare",
        mainWorktree: null,
        worktrees: [],
        localOnlyBranches: [],
        findings: [],
        remotes: [],
        primaryRemote: null,
        upstreamRemote: null,
        bd_workspace_prefix: "demo-repo",
      },
    ],
  };
  writeFileSync(join(indexDir, "config.json"), `${JSON.stringify({}, null, 2)}\n`);
  writeFileSync(join(indexDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);

  const runner: RepoRunner = (cmd, options = {}) => {
    if (cmd[0] === "git" && cmd[1] === "rev-parse" && cmd[2] === "--show-toplevel") {
      const cwd = options.cwd ?? "";
      if (cwd === root || cwd.startsWith(`${root}/`)) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "not a git repository", status: 128 };
    }
    return { stdout: "", stderr: "", status: 0 };
  };

  return { root, aiHomeWt, spdBare, runner };
}

describe("repo_router — end-to-end against a real index", () => {
  test("foreign-prefixed BD long-id routes to the spd bare and re-dispatches", () => {
    const { aiHomeWt, spdBare, runner } = fixture();

    const redispatchArgs: Array<{
      surfaceId: string;
      repo: string;
      barePath: string;
    }> = [];
    let materializeCalls = 0;

    const result = runRepoRouter(
      {
        surfaceId: "BD-demo-repo-1778515181936-7-edba9d4a",
        cwd: aiHomeWt,
      },
      {
        loadRepoInventoryConfig: (cwd) => loadRepoInventoryConfig(cwd, runner),
        loadRepoInventoryIndex,
        localWorkspacePrefixForCwd: (cwd) => localWorkspacePrefixForCwd(cwd, runner),
        materializeRepo: (repo) => {
          materializeCalls += 1;
          return { action: "cloned", barePath: repo.commonDir };
        },
        redispatchOpenPlanSession: (input) => {
          redispatchArgs.push(input);
        },
        // Silence audit-sink side effects in the integration test.
        recordEvent: () => {},
      },
    );

    expect(result).toEqual({
      status: "routed",
      repo: "demo-repo",
      barePath: spdBare,
      action: "cloned",
    });
    expect(materializeCalls).toBe(1);
    // The acceptance criterion: the re-dispatched session "reaches the
    // foreign bd workspace" — i.e. the orchestrator hands the caller
    // `(repo, barePath)` pointing at the spd bare.
    expect(redispatchArgs).toEqual([
      {
        surfaceId: "BD-demo-repo-1778515181936-7-edba9d4a",
        repo: "demo-repo",
        barePath: spdBare,
      },
    ]);
  });

  test("local-prefixed long-id short-circuits without materializing", () => {
    const { aiHomeWt, runner } = fixture();
    let materializeCalls = 0;
    const result = runRepoRouter(
      {
        surfaceId: "BD-ai-home-1778515181936-7-edba9d4a",
        cwd: aiHomeWt,
      },
      {
        loadRepoInventoryConfig: (cwd) => loadRepoInventoryConfig(cwd, runner),
        loadRepoInventoryIndex,
        localWorkspacePrefixForCwd: (cwd) => localWorkspacePrefixForCwd(cwd, runner),
        materializeRepo: () => {
          materializeCalls += 1;
          return { action: "cloned", barePath: "/should-not-be-called" };
        },
        recordEvent: () => {},
      },
    );
    expect(result).toEqual({ status: "local", prefix: "ai-home" });
    expect(materializeCalls).toBe(0);
  });
});

// GH-1661 — dispatchFromArgvWithRouting end-to-end against three acceptance
// combos: implicit foreign route, explicit --repo matches, explicit --repo
// conflicts. Each scenario stubs `materializeRepo` so the test does not
// shell out, but the routing decision flows through the real router.
describe("dispatchFromArgvWithRouting — --repo threading", () => {
  function makeDeps(fixtureBundle: ReturnType<typeof fixture>): DispatchFromArgvRoutingDeps {
    const { aiHomeWt, runner } = fixtureBundle;
    return {
      cwd: () => aiHomeWt,
      routerDeps: {
        loadRepoInventoryConfig: (cwd) => loadRepoInventoryConfig(cwd, runner),
        loadRepoInventoryIndex,
        localWorkspacePrefixForCwd: (cwd) => localWorkspacePrefixForCwd(cwd, runner),
        materializeRepo: (repo) => ({
          action: "cloned",
          barePath: repo.commonDir,
        }),
        recordEvent: () => {},
      },
    };
  }

  test("implicit foreign route (no --repo, BD foreign prefix) → routed", () => {
    const bundle = fixture();
    const restore = setSessionEntryStderrSink(() => {});
    try {
      const result = dispatchFromArgvWithRouting(
        ["plan", "session", "BD-demo-repo-1778515181936-7-edba9d4a"],
        makeDeps(bundle),
      );
      expect(result.kind).toBe("routed");
      if (result.kind === "routed") {
        expect(result.repo).toBe("demo-repo");
        expect(result.barePath).toBe(bundle.spdBare);
      }
    } finally {
      restore();
      resetSessionEntryStderr();
    }
  });

  test("explicit --repo matches embedded prefix → routed (no refusal)", () => {
    const bundle = fixture();
    const restore = setSessionEntryStderrSink(() => {});
    try {
      const result = dispatchFromArgvWithRouting(
        ["plan", "session", "BD-demo-repo-1778515181936-7-edba9d4a", "--repo", "demo-repo"],
        makeDeps(bundle),
      );
      expect(result.kind).toBe("routed");
      if (result.kind === "routed") {
        expect(result.repo).toBe("demo-repo");
      }
    } finally {
      restore();
      resetSessionEntryStderr();
    }
  });

  test("explicit --repo conflicts with embedded prefix → refused (no materialize)", () => {
    const bundle = fixture();
    const result = dispatchFromArgvWithRouting(
      ["plan", "session", "BD-demo-repo-1778515181936-7-edba9d4a", "--repo", "ai-home"],
      makeDeps(bundle),
    );
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") {
      expect(result.reason).toBe("conflict");
      expect(result.hint).toContain("--repo ai-home");
      expect(result.hint).toContain("demo-repo");
    }
  });

  test("non-BD surface id → profile (router unrecognized arm, no refusal)", () => {
    const bundle = fixture();
    const restore = setSessionEntryStderrSink(() => {});
    try {
      const result = dispatchFromArgvWithRouting(
        ["plan", "session", "GH-1661", "--repo", "any-repo-name"],
        makeDeps(bundle),
      );
      expect(result.kind).toBe("profile");
    } finally {
      restore();
      resetSessionEntryStderr();
    }
  });

  test("local-prefix long-id → profile (router local arm, no router events)", () => {
    const bundle = fixture();
    const restore = setSessionEntryStderrSink(() => {});
    try {
      const result = dispatchFromArgvWithRouting(
        ["plan", "session", "BD-ai-home-1778515181936-7-edba9d4a"],
        makeDeps(bundle),
      );
      expect(result.kind).toBe("profile");
    } finally {
      restore();
      resetSessionEntryStderr();
    }
  });
});

describe("repo_router — catalog wiring (acceptance: prx actors --scope workflow)", () => {
  test("repo_router is listed under the workflow scope with its emits and the route accept", () => {
    const workflowActors = actorsForScope("workflow");
    const router = workflowActors.find((a) => a.actor === "repo_router");
    expect(router).toBeDefined();
    expect(router?.tier).toBe("planning");
    expect(router?.kind).toBe("cli");
    expect(router?.domain).toBe("cross_repo_routing");
    // `BARE_MATERIALIZED` is owned by `wt` (GH-1660 / #1676); the
    // router consumes it on the `materializing → routed` edge but
    // does not emit it.
    expect(router?.emits.sort()).toEqual(
      [
        "BD_PREFIX_DETECTED",
        "REPO_PIN_RESOLVED",
        "ROUTE_FAILED",
        "ROUTE_REFUSED_CONFLICT",
        "ROUTE_REFUSED_NO_PIN",
        "SESSION_RE_DISPATCHED",
      ].sort(),
    );
    expect(router?.accepts).toEqual(["route"]);
  });

  test("router-owned events map to repo_router; BARE_MATERIALIZED stays on wt", () => {
    for (const event of [
      "BD_PREFIX_DETECTED",
      "REPO_PIN_RESOLVED",
      "SESSION_RE_DISPATCHED",
      "ROUTE_REFUSED_NO_PIN",
      "ROUTE_REFUSED_CONFLICT",
      "ROUTE_FAILED",
    ]) {
      expect(eventOwnerMap[event]).toBe("repo_router");
    }
    expect(eventOwnerMap.BARE_MATERIALIZED).toBe("wt");
  });

  test("toolActorCatalog.repo_router matches actorsForScope output (no skew)", () => {
    const direct = toolActorCatalog.repo_router;
    const fromScope = actorsForScope("workflow").find((a) => a.actor === "repo_router");
    expect(direct).toEqual(fromScope!);
  });
});
