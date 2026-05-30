// GH-1659 — `runRepoRouter` orchestrator unit tests.
//
// Deps fully stubbed. Each scenario pins one acceptance arm from the
// plan (§5.2): local short-circuit, foreign happy path, missing-pin
// refusal, failed-materialize, I-RR5 dry-run, I-RR2 inventory atomicity.
//
// The orchestrator emits via two sinks per event — `recordEvent` (audit
// chain) AND `actor.send` (machine context). Tests pin the
// `recordEvent` call order; the machine-side projection is the
// machine test's job (`test/machine/machines/repo_router.test.ts`).

import { describe, expect, test } from "bun:test";

import {
  conflictHint,
  decideRoute,
  missingPinHint,
  runRepoRouter,
  type RunRepoRouterDeps,
} from "../../src/repo_router/index.ts";
import type {
  LocalRepo,
  RepoInventory,
  RepoInventoryConfig,
} from "../../src/pr-state/repos.ts";

function makeLocalRepo(overrides: Partial<LocalRepo>): LocalRepo {
  return {
    name: overrides.name ?? "demo-repo",
    commonDir:
      overrides.commonDir ?? "/Users/dev/.local/state/bare/demo-repo.git",
    kind: overrides.kind ?? "bare",
    mainWorktree: overrides.mainWorktree ?? null,
    worktrees: overrides.worktrees ?? [],
    localOnlyBranches: overrides.localOnlyBranches ?? [],
    findings: overrides.findings ?? [],
    remotes: overrides.remotes ?? [],
    primaryRemote: overrides.primaryRemote ?? null,
    upstreamRemote: overrides.upstreamRemote ?? null,
    bd_workspace_prefix: overrides.bd_workspace_prefix,
  };
}

function makeInventory(repos: LocalRepo[]): RepoInventory {
  return {
    roots: [],
    repos,
  };
}

function makeConfig(): RepoInventoryConfig {
  return {
    repoRoot: "/tmp/repo",
    bareRoot: "/tmp/bare",
    roots: [],
    everywhereRoots: [],
    globalConfigPath: null,
    configPath: null,
    indexPath: "/tmp/.prx/repos/index.json",
  };
}

type EventCall = { event: string; details?: Record<string, unknown> | undefined };

function makeRecorder(): {
  calls: EventCall[];
  recordEvent: NonNullable<RunRepoRouterDeps["recordEvent"]>;
} {
  const calls: EventCall[] = [];
  const recordEvent: NonNullable<RunRepoRouterDeps["recordEvent"]> = (
    event,
    opts,
  ) => {
    calls.push({ event, details: opts?.details });
  };
  return { calls, recordEvent };
}

describe("decideRoute — pure classifier", () => {
  test("unrecognized: surface id is not a BD long-id", () => {
    expect(decideRoute("GH-123", makeInventory([]), null)).toEqual({
      kind: "unrecognized",
    });
    expect(decideRoute("BD-DEADBEEF", makeInventory([]), null)).toEqual({
      kind: "unrecognized",
    });
  });

  test("local: embedded prefix matches localPrefix", () => {
    expect(
      decideRoute(
        "BD-ai-home-1777747201085-737-407f177f",
        makeInventory([]),
        "ai-home",
      ),
    ).toEqual({ kind: "local", prefix: "ai-home" });
  });

  test("foreign: prefix hits a non-local LocalRepo in the index", () => {
    const repo = makeLocalRepo({
      name: "demo-repo",
      bd_workspace_prefix: "demo-repo",
      commonDir: "/tmp/bare/demo-repo.git",
    });
    const out = decideRoute(
      "BD-demo-repo-1777747201085-737-407f177f",
      makeInventory([repo]),
      "ai-home",
    );
    expect(out).toEqual({
      kind: "foreign",
      prefix: "demo-repo",
      repo,
      barePath: "/tmp/bare/demo-repo.git",
    });
  });

  test("missing-pin: prefix has no index entry", () => {
    expect(
      decideRoute(
        "BD-unknown-prefix-1777747201085-737-407f177f",
        makeInventory([]),
        "ai-home",
      ),
    ).toEqual({ kind: "missing-pin", prefix: "unknown-prefix" });
  });

  test("null inventory falls through to missing-pin", () => {
    expect(
      decideRoute(
        "BD-demo-repo-1777747201085-737-407f177f",
        null,
        "ai-home",
      ),
    ).toEqual({ kind: "missing-pin", prefix: "demo-repo" });
  });
});

describe("runRepoRouter — local arm short-circuits", () => {
  test("returns local without emitting any events or calling materialize", () => {
    const { calls, recordEvent } = makeRecorder();
    let materializeCalls = 0;
    let redispatchCalls = 0;
    const result = runRepoRouter(
      {
        surfaceId: "BD-ai-home-1777747201085-737-407f177f",
        cwd: "/tmp/repo",
      },
      {
        loadRepoInventoryConfig: () => makeConfig(),
        loadRepoInventoryIndex: () => makeInventory([]),
        localWorkspacePrefixForCwd: () => "ai-home",
        materializeRepo: () => {
          materializeCalls += 1;
          return { action: "noop", barePath: "/should-not-be-called" };
        },
        redispatchOpenPlanSession: () => {
          redispatchCalls += 1;
        },
        recordEvent,
      },
    );

    expect(result).toEqual({ status: "local", prefix: "ai-home" });
    expect(calls).toEqual([]);
    expect(materializeCalls).toBe(0);
    expect(redispatchCalls).toBe(0);
  });
});

describe("runRepoRouter — foreign happy path", () => {
  test("emits the six events in ADR §5 order and returns routed", () => {
    const repo = makeLocalRepo({
      name: "demo-repo",
      bd_workspace_prefix: "demo-repo",
      commonDir: "/tmp/bare/demo-repo.git",
    });
    const { calls, recordEvent } = makeRecorder();
    const materializeArgs: Array<{ repo: LocalRepo; dryRun: boolean }> = [];
    const redispatchArgs: Array<{
      surfaceId: string;
      repo: string;
      barePath: string;
    }> = [];

    const result = runRepoRouter(
      {
        surfaceId: "BD-demo-repo-1777747201085-737-407f177f",
        cwd: "/tmp/ai-home-worktree",
      },
      {
        loadRepoInventoryConfig: () => makeConfig(),
        loadRepoInventoryIndex: () => makeInventory([repo]),
        localWorkspacePrefixForCwd: () => "ai-home",
        materializeRepo: (r, opts) => {
          materializeArgs.push({ repo: r, dryRun: opts.dryRun });
          return {
            action: "cloned",
            barePath: "/tmp/bare/demo-repo.git",
          };
        },
        redispatchOpenPlanSession: (input) => {
          redispatchArgs.push(input);
        },
        recordEvent,
      },
    );

    expect(result).toEqual({
      status: "routed",
      repo: "demo-repo",
      barePath: "/tmp/bare/demo-repo.git",
      action: "cloned",
    });
    expect(calls.map((c) => c.event)).toEqual([
      "BD_PREFIX_DETECTED",
      "REPO_PIN_RESOLVED",
      "BARE_MATERIALIZED",
      "SESSION_RE_DISPATCHED",
    ]);
    expect(calls[2]?.details).toEqual({
      repo: "demo-repo",
      barePath: "/tmp/bare/demo-repo.git",
      action: "cloned",
    });
    expect(materializeArgs).toEqual([{ repo, dryRun: false }]);
    expect(redispatchArgs).toEqual([
      {
        surfaceId: "BD-demo-repo-1777747201085-737-407f177f",
        repo: "demo-repo",
        barePath: "/tmp/bare/demo-repo.git",
      },
    ]);
  });
});

describe("runRepoRouter — missing-pin arm", () => {
  test("emits BD_PREFIX_DETECTED + ROUTE_REFUSED_NO_PIN with the structured hint", () => {
    const { calls, recordEvent } = makeRecorder();
    let materializeCalls = 0;
    let redispatchCalls = 0;

    const result = runRepoRouter(
      {
        surfaceId: "BD-demo-repo-1777747201085-737-407f177f",
        cwd: "/tmp/ai-home-worktree",
      },
      {
        loadRepoInventoryConfig: () => makeConfig(),
        loadRepoInventoryIndex: () => makeInventory([]),
        localWorkspacePrefixForCwd: () => "ai-home",
        materializeRepo: () => {
          materializeCalls += 1;
          return { action: "noop", barePath: "/should-not-be-called" };
        },
        redispatchOpenPlanSession: () => {
          redispatchCalls += 1;
        },
        recordEvent,
      },
    );

    expect(result.status).toBe("refused-no-pin");
    if (result.status === "refused-no-pin") {
      expect(result.prefix).toBe("demo-repo");
      expect(result.hint).toBe(missingPinHint("demo-repo"));
      // ADR §6 byte-pin: hint is the only operator-facing surface — make
      // sure the literal text the design doc promises is present.
      expect(result.hint).toContain(
        'bd workspace prefix "demo-repo" is not pinned',
      );
      expect(result.hint).toContain(
        "prx repo add --bd-workspace-prefix demo-repo",
      );
    }
    expect(calls.map((c) => c.event)).toEqual([
      "BD_PREFIX_DETECTED",
      "ROUTE_REFUSED_NO_PIN",
    ]);
    expect(materializeCalls).toBe(0);
    expect(redispatchCalls).toBe(0);
  });
});

describe("runRepoRouter — failed-materialize arm", () => {
  test("emits ROUTE_FAILED with the thrown error's message; no BARE_MATERIALIZED or redispatch", () => {
    const repo = makeLocalRepo({
      name: "demo-repo",
      bd_workspace_prefix: "demo-repo",
      commonDir: "/tmp/bare/demo-repo.git",
    });
    const { calls, recordEvent } = makeRecorder();
    let redispatchCalls = 0;

    const result = runRepoRouter(
      {
        surfaceId: "BD-demo-repo-1777747201085-737-407f177f",
        cwd: "/tmp/ai-home-worktree",
      },
      {
        loadRepoInventoryConfig: () => makeConfig(),
        loadRepoInventoryIndex: () => makeInventory([repo]),
        localWorkspacePrefixForCwd: () => "ai-home",
        materializeRepo: () => {
          throw new Error("git clone --bare failed: exit 128");
        },
        redispatchOpenPlanSession: () => {
          redispatchCalls += 1;
        },
        recordEvent,
      },
    );

    expect(result).toEqual({
      status: "failed",
      reason: "git clone --bare failed: exit 128",
    });
    expect(calls.map((c) => c.event)).toEqual([
      "BD_PREFIX_DETECTED",
      "REPO_PIN_RESOLVED",
      "ROUTE_FAILED",
    ]);
    expect(redispatchCalls).toBe(0);
  });
});

describe("runRepoRouter — I-RR5 dry-run", () => {
  test("emits the full six-event chain with action=noop and zero dep calls", () => {
    const repo = makeLocalRepo({
      name: "demo-repo",
      bd_workspace_prefix: "demo-repo",
      commonDir: "/tmp/bare/demo-repo.git",
    });
    const { calls, recordEvent } = makeRecorder();
    let materializeCalls = 0;
    let redispatchCalls = 0;

    const result = runRepoRouter(
      {
        surfaceId: "BD-demo-repo-1777747201085-737-407f177f",
        cwd: "/tmp/ai-home-worktree",
        dryRun: true,
      },
      {
        loadRepoInventoryConfig: () => makeConfig(),
        loadRepoInventoryIndex: () => makeInventory([repo]),
        localWorkspacePrefixForCwd: () => "ai-home",
        materializeRepo: () => {
          materializeCalls += 1;
          return { action: "cloned", barePath: "/should-not-be-called" };
        },
        redispatchOpenPlanSession: () => {
          redispatchCalls += 1;
        },
        recordEvent,
      },
    );

    expect(result).toEqual({
      status: "routed",
      repo: "demo-repo",
      barePath: "/tmp/bare/demo-repo.git",
      action: "noop",
    });
    expect(calls.map((c) => c.event)).toEqual([
      "BD_PREFIX_DETECTED",
      "REPO_PIN_RESOLVED",
      "BARE_MATERIALIZED",
      "SESSION_RE_DISPATCHED",
    ]);
    expect(calls[2]?.details).toEqual({
      repo: "demo-repo",
      barePath: "/tmp/bare/demo-repo.git",
      action: "noop",
    });
    expect(materializeCalls).toBe(0);
    expect(redispatchCalls).toBe(0);
  });
});

describe("runRepoRouter — I-RR2 inventory atomicity", () => {
  test("loadRepoInventoryIndex is called exactly once per tick", () => {
    const repo = makeLocalRepo({
      name: "demo-repo",
      bd_workspace_prefix: "demo-repo",
      commonDir: "/tmp/bare/demo-repo.git",
    });
    let indexReads = 0;
    let configReads = 0;
    let localPrefixReads = 0;

    runRepoRouter(
      {
        surfaceId: "BD-demo-repo-1777747201085-737-407f177f",
        cwd: "/tmp/ai-home-worktree",
      },
      {
        loadRepoInventoryConfig: () => {
          configReads += 1;
          return makeConfig();
        },
        loadRepoInventoryIndex: () => {
          indexReads += 1;
          return makeInventory([repo]);
        },
        localWorkspacePrefixForCwd: () => {
          localPrefixReads += 1;
          return "ai-home";
        },
        materializeRepo: () => ({
          action: "cloned",
          barePath: "/tmp/bare/demo-repo.git",
        }),
        recordEvent: () => {},
      },
    );

    expect(indexReads).toBe(1);
    expect(configReads).toBe(1);
    expect(localPrefixReads).toBe(1);
  });
});

describe("runRepoRouter — unrecognized surface id", () => {
  test("returns unrecognized without invoking inventory load or emitting events", () => {
    const { calls, recordEvent } = makeRecorder();
    const result = runRepoRouter(
      { surfaceId: "GH-1659", cwd: "/tmp" },
      {
        loadRepoInventoryConfig: () => makeConfig(),
        loadRepoInventoryIndex: () => makeInventory([]),
        localWorkspacePrefixForCwd: () => null,
        recordEvent,
      },
    );
    expect(result).toEqual({ status: "unrecognized" });
    expect(calls).toEqual([]);
  });
});

// GH-1661 — `--repo` override + conflict arm
describe("runRepoRouter — repoOverride matches foreign decision", () => {
  test("foreign happy path proceeds; materialize still invoked", () => {
    const repo = makeLocalRepo({
      name: "demo-repo",
      bd_workspace_prefix: "demo-repo",
      commonDir: "/tmp/bare/demo-repo.git",
    });
    const { calls, recordEvent } = makeRecorder();
    let materializeCalls = 0;
    let redispatchCalls = 0;
    const result = runRepoRouter(
      {
        surfaceId: "BD-demo-repo-1777747201085-737-407f177f",
        cwd: "/tmp/ai-home-worktree",
        repoOverride: "demo-repo",
      },
      {
        loadRepoInventoryConfig: () => makeConfig(),
        loadRepoInventoryIndex: () => makeInventory([repo]),
        localWorkspacePrefixForCwd: () => "ai-home",
        materializeRepo: () => {
          materializeCalls += 1;
          return { action: "cloned", barePath: "/tmp/bare/demo-repo.git" };
        },
        redispatchOpenPlanSession: () => {
          redispatchCalls += 1;
        },
        recordEvent,
      },
    );
    expect(result.status).toBe("routed");
    expect(materializeCalls).toBe(1);
    expect(redispatchCalls).toBe(1);
    expect(calls.map((c) => c.event)).toEqual([
      "BD_PREFIX_DETECTED",
      "REPO_PIN_RESOLVED",
      "BARE_MATERIALIZED",
      "SESSION_RE_DISPATCHED",
    ]);
  });
});

describe("runRepoRouter — repoOverride conflicts with foreign decision", () => {
  test("emits ROUTE_REFUSED_CONFLICT; no materialize, no redispatch", () => {
    const repo = makeLocalRepo({
      name: "demo-repo",
      bd_workspace_prefix: "demo-repo",
      commonDir: "/tmp/bare/demo-repo.git",
    });
    const { calls, recordEvent } = makeRecorder();
    let materializeCalls = 0;
    let redispatchCalls = 0;
    const result = runRepoRouter(
      {
        surfaceId: "BD-demo-repo-1777747201085-737-407f177f",
        cwd: "/tmp/ai-home-worktree",
        repoOverride: "ai-home",
      },
      {
        loadRepoInventoryConfig: () => makeConfig(),
        loadRepoInventoryIndex: () => makeInventory([repo]),
        localWorkspacePrefixForCwd: () => "ai-home",
        materializeRepo: () => {
          materializeCalls += 1;
          return { action: "noop", barePath: "/should-not-be-called" };
        },
        redispatchOpenPlanSession: () => {
          redispatchCalls += 1;
        },
        recordEvent,
      },
    );
    expect(result.status).toBe("refused-conflict");
    if (result.status === "refused-conflict") {
      expect(result.requestedRepo).toBe("ai-home");
      expect(result.embeddedPrefix).toBe("demo-repo");
      expect(result.embeddedRepo).toBe("demo-repo");
      expect(result.hint).toBe(
        conflictHint("ai-home", "demo-repo", "demo-repo"),
      );
      expect(result.hint).toContain("--repo ai-home");
      expect(result.hint).toContain("demo-repo");
    }
    expect(calls.map((c) => c.event)).toEqual([
      "BD_PREFIX_DETECTED",
      "ROUTE_REFUSED_CONFLICT",
    ]);
    expect(materializeCalls).toBe(0);
    expect(redispatchCalls).toBe(0);
  });
});

describe("runRepoRouter — repoOverride with unrecognized surface id", () => {
  test("override is ignored at the router seam; returns unrecognized", () => {
    const { calls, recordEvent } = makeRecorder();
    const result = runRepoRouter(
      { surfaceId: "GH-1659", cwd: "/tmp", repoOverride: "ai-home" },
      {
        loadRepoInventoryConfig: () => makeConfig(),
        loadRepoInventoryIndex: () => makeInventory([]),
        localWorkspacePrefixForCwd: () => null,
        recordEvent,
      },
    );
    expect(result).toEqual({ status: "unrecognized" });
    expect(calls).toEqual([]);
  });
});

describe("runRepoRouter — repoOverride with missing-pin decision", () => {
  test("missing-pin still wins; override is informational only", () => {
    const { calls, recordEvent } = makeRecorder();
    const result = runRepoRouter(
      {
        surfaceId: "BD-demo-repo-1777747201085-737-407f177f",
        cwd: "/tmp/ai-home-worktree",
        repoOverride: "ai-home",
      },
      {
        loadRepoInventoryConfig: () => makeConfig(),
        loadRepoInventoryIndex: () => makeInventory([]),
        localWorkspacePrefixForCwd: () => "ai-home",
        recordEvent,
      },
    );
    expect(result.status).toBe("refused-no-pin");
    expect(calls.map((c) => c.event)).toEqual([
      "BD_PREFIX_DETECTED",
      "ROUTE_REFUSED_NO_PIN",
    ]);
  });
});

describe("runRepoRouter — repoOverride matches local arm", () => {
  test("no events emitted; returns local", () => {
    const aiHomeRepo = makeLocalRepo({
      name: "ai-home",
      bd_workspace_prefix: "ai-home",
      commonDir: "/tmp/bare/ai-home.git",
    });
    const { calls, recordEvent } = makeRecorder();
    const result = runRepoRouter(
      {
        surfaceId: "BD-ai-home-1777747201085-737-407f177f",
        cwd: "/tmp/ai-home-worktree",
        repoOverride: "ai-home",
      },
      {
        loadRepoInventoryConfig: () => makeConfig(),
        loadRepoInventoryIndex: () => makeInventory([aiHomeRepo]),
        localWorkspacePrefixForCwd: () => "ai-home",
        recordEvent,
      },
    );
    expect(result).toEqual({ status: "local", prefix: "ai-home" });
    expect(calls).toEqual([]);
  });
});

describe("runRepoRouter — repoOverride conflicts with local arm", () => {
  test("emits ROUTE_REFUSED_CONFLICT when --repo X disagrees with local repo Y", () => {
    const aiHomeRepo = makeLocalRepo({
      name: "ai-home",
      bd_workspace_prefix: "ai-home",
      commonDir: "/tmp/bare/ai-home.git",
    });
    const { calls, recordEvent } = makeRecorder();
    const result = runRepoRouter(
      {
        surfaceId: "BD-ai-home-1777747201085-737-407f177f",
        cwd: "/tmp/ai-home-worktree",
        repoOverride: "demo-repo",
      },
      {
        loadRepoInventoryConfig: () => makeConfig(),
        loadRepoInventoryIndex: () => makeInventory([aiHomeRepo]),
        localWorkspacePrefixForCwd: () => "ai-home",
        recordEvent,
      },
    );
    expect(result.status).toBe("refused-conflict");
    if (result.status === "refused-conflict") {
      expect(result.requestedRepo).toBe("demo-repo");
      expect(result.embeddedPrefix).toBe("ai-home");
      expect(result.embeddedRepo).toBe("ai-home");
    }
    expect(calls.map((c) => c.event)).toEqual([
      "BD_PREFIX_DETECTED",
      "ROUTE_REFUSED_CONFLICT",
    ]);
  });
});

describe("runRepoRouter — foreign arm with no materialize dep", () => {
  test("ROUTE_FAILED when the materialize dep is not supplied", () => {
    const repo = makeLocalRepo({
      name: "demo-repo",
      bd_workspace_prefix: "demo-repo",
      commonDir: "/tmp/bare/demo-repo.git",
    });
    const { calls, recordEvent } = makeRecorder();
    const result = runRepoRouter(
      {
        surfaceId: "BD-demo-repo-1777747201085-737-407f177f",
        cwd: "/tmp/ai-home-worktree",
      },
      {
        loadRepoInventoryConfig: () => makeConfig(),
        loadRepoInventoryIndex: () => makeInventory([repo]),
        localWorkspacePrefixForCwd: () => "ai-home",
        recordEvent,
      },
    );
    expect(result.status).toBe("failed");
    expect(calls.map((c) => c.event)).toEqual([
      "BD_PREFIX_DETECTED",
      "REPO_PIN_RESOLVED",
      "ROUTE_FAILED",
    ]);
  });
});
