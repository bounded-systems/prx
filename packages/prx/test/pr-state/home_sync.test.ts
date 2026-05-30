import { describe, expect, test } from "bun:test";

import {
  runHomeSync,
  type HomeSyncDeps,
  type HomeSyncOptions,
  type HomeSyncSpawn,
} from "../../src/pr-state/home-sync.ts";
import { runCli } from "../../src/pr-state/cli.ts";
import type {
  WorktreeStatus,
  CommandRunner,
} from "../../src/pr-state/github.ts";

function cleanStatus(): WorktreeStatus {
  return {
    branch: {
      name: null,
      detached: true,
      noCommits: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      diverged: false,
      sync: "no_upstream",
    },
    files: { staged: [], unstaged: [], untracked: [], ignored: [], conflicts: [] },
    counts: { staged: 0, unstaged: 0, untracked: 0, ignored: 0, conflicts: 0 },
    clean: true,
    codes: {} as WorktreeStatus["codes"],
  };
}

function dirtyStatus(): WorktreeStatus {
  const s = cleanStatus();
  s.clean = false;
  s.counts = { staged: 1, unstaged: 2, untracked: 3, ignored: 0, conflicts: 0 };
  s.files = {
    staged: ["a.ts"],
    unstaged: ["b.ts", "c.ts"],
    untracked: ["d", "e", "f"],
    ignored: [],
    conflicts: [],
  };
  return s;
}

type Fixture = {
  output: { log: (l: string) => void; error: (e: string) => void };
  logs: string[];
  errs: string[];
  prepareCalls: string[];
  updateCalls: Array<{ options: HomeSyncOptions }>;
  spawnCalls: Array<{ file: string; args: string[]; cwd: string }>;
  deps: HomeSyncDeps;
};

function makeFixture(params: {
  cwd?: string;
  toplevel?: string;
  status?: WorktreeStatus;
  prepareThrows?: Error;
  updateExit?: number;
  updateLogs?: string[];
}): Fixture {
  const logs: string[] = [];
  const errs: string[] = [];
  const prepareCalls: string[] = [];
  const updateCalls: Array<{ options: HomeSyncOptions }> = [];
  const spawnCalls: Array<{ file: string; args: string[]; cwd: string }> = [];
  const cwd = params.cwd ?? "/wt/main/mainx";
  const toplevel = params.toplevel ?? "/wt/main/mainx";

  const spawn: HomeSyncSpawn = (file, args, opts) => {
    spawnCalls.push({ file, args, cwd: opts.cwd });
    if (file === "git" && args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { status: 0, stdout: toplevel + "\n" };
    }
    return { status: 0, stdout: "" };
  };

  const runner: CommandRunner = () => ({ stdout: "", stderr: "", status: 0 });

  const deps: HomeSyncDeps = {
    cwd,
    spawn,
    runner,
    worktreeStatus: () => params.status ?? cleanStatus(),
    prepareMainx: (tl: string) => {
      prepareCalls.push(tl);
      if (params.prepareThrows) throw params.prepareThrows;
      return tl;
    },
    runHomeUpdate: (options, output) => {
      updateCalls.push({ options });
      for (const line of params.updateLogs ?? []) output.log(line);
      return params.updateExit ?? 0;
    },
  };

  return {
    output: { log: (l) => logs.push(l), error: (e) => errs.push(e) },
    logs,
    errs,
    prepareCalls,
    updateCalls,
    spawnCalls,
    deps,
  };
}

const baseOpts: HomeSyncOptions = {
  flakeDir: "/fake/flake",
  input: "ai-home",
  dryRun: false,
  format: "plain",
};

describe("runHomeSync", () => {
  test("refuses when cwd toplevel is not mainx and points at `prx delegate next`", () => {
    const fx = makeFixture({ toplevel: "/wt/main/gh_999_abc" });

    const exit = runHomeSync(baseOpts, fx.output, fx.deps);

    expect(exit).toBe(2);
    expect(fx.errs.join("\n")).toContain("must run from the mainx worktree");
    expect(fx.errs.join("\n")).toContain('got "gh_999_abc"');
    expect(fx.errs.join("\n")).toContain("prx delegate next");
    expect(fx.prepareCalls).toHaveLength(0);
    expect(fx.updateCalls).toHaveLength(0);
  });

  test("refuses when working tree is dirty and lists counts", () => {
    const fx = makeFixture({ status: dirtyStatus() });

    const exit = runHomeSync(baseOpts, fx.output, fx.deps);

    expect(exit).toBe(2);
    const err = fx.errs.join("\n");
    expect(err).toContain("working tree is dirty");
    expect(err).toContain("1 staged");
    expect(err).toContain("2 unstaged");
    expect(err).toContain("3 untracked");
    expect(err).toContain("git status");
    expect(fx.prepareCalls).toHaveLength(0);
    expect(fx.updateCalls).toHaveLength(0);
  });

  test("refuses when not in a git repository", () => {
    const fx = makeFixture({});
    // Override spawn to fail rev-parse
    fx.deps.spawn = () => ({ status: 128, stderr: "fatal: not a git repository" });

    const exit = runHomeSync(baseOpts, fx.output, fx.deps);

    expect(exit).toBe(2);
    expect(fx.errs.join("\n")).toContain("not in a git repository");
  });

  test("happy path calls prepareMainx with the toplevel then runHomeUpdate", () => {
    const fx = makeFixture({});

    const exit = runHomeSync(baseOpts, fx.output, fx.deps);

    expect(exit).toBe(0);
    expect(fx.prepareCalls).toEqual(["/wt/main/mainx"]);
    expect(fx.updateCalls).toHaveLength(1);
    expect(fx.updateCalls[0]!.options).toEqual(baseOpts);
    expect(fx.logs.join("\n")).toContain("mainx ✓ clean ✓");
  });

  test("propagates non-zero exit code from runHomeUpdate", () => {
    const fx = makeFixture({ updateExit: 42 });

    const exit = runHomeSync(baseOpts, fx.output, fx.deps);

    expect(exit).toBe(42);
    expect(fx.prepareCalls).toHaveLength(1);
  });

  test("renders prepareMainx CliError with `prx home sync:` prefix and exit 1", () => {
    const fx = makeFixture({ prepareThrows: new Error("mainx: git fetch failed: timeout") });

    const exit = runHomeSync(baseOpts, fx.output, fx.deps);

    expect(exit).toBe(1);
    expect(fx.errs.join("\n")).toContain("prx home sync:");
    expect(fx.errs.join("\n")).toContain("git fetch failed");
    expect(fx.updateCalls).toHaveLength(0);
  });

  test("dry-run does not call prepareMainx; runHomeUpdate is called with dryRun=true", () => {
    const fx = makeFixture({});

    const exit = runHomeSync(
      { ...baseOpts, dryRun: true },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    expect(fx.prepareCalls).toHaveLength(0);
    expect(fx.updateCalls).toHaveLength(1);
    expect(fx.updateCalls[0]!.options.dryRun).toBe(true);
    expect(fx.logs.join("\n")).toContain("(dry-run)");
    expect(fx.logs.join("\n")).toContain("git fetch origin");
    expect(fx.logs.join("\n")).toContain("git checkout --detach origin/main");
  });

  test("dry-run JSON envelope nests homeUpdate payload and sets fetch.ran=false", () => {
    const fx = makeFixture({
      updateLogs: [JSON.stringify({ dryRun: true, flakeDir: "/fake/flake", input: "ai-home" }, null, 2)],
    });

    const exit = runHomeSync(
      { ...baseOpts, dryRun: true, format: "json" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    expect(fx.logs).toHaveLength(1);
    const payload = JSON.parse(fx.logs[0]!);
    expect(payload.dryRun).toBe(true);
    expect(payload.guards).toEqual({ mainx: "ok", clean: "ok" });
    expect(payload.fetch).toEqual({ ran: false, plan: ["git", "fetch", "origin"] });
    expect(payload.detach).toEqual({ ran: false, plan: ["git", "checkout", "--detach", "origin/main"] });
    expect(payload.homeUpdate.dryRun).toBe(true);
    expect(payload.homeUpdate.input).toBe("ai-home");
  });

  test("live JSON envelope nests homeUpdate payload and sets fetch.ran=true", () => {
    const fx = makeFixture({
      updateLogs: [JSON.stringify({ flakeDir: "/fake/flake", from: "abc", to: "def", noop: false, switched: true }, null, 2)],
    });

    const exit = runHomeSync(
      { ...baseOpts, format: "json" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    expect(fx.prepareCalls).toEqual(["/wt/main/mainx"]);
    expect(fx.logs).toHaveLength(1);
    const payload = JSON.parse(fx.logs[0]!);
    expect(payload.dryRun).toBe(false);
    expect(payload.guards).toEqual({ mainx: "ok", clean: "ok" });
    expect(payload.fetch).toEqual({ ran: true });
    expect(payload.detach).toEqual({ ran: true, target: "origin/main" });
    expect(payload.homeUpdate.from).toBe("abc");
    expect(payload.homeUpdate.to).toBe("def");
    expect(payload.homeUpdate.switched).toBe(true);
  });

  test("non-mainx JSON refusal: still emits a parseable error path (errors go to stderr, no logs)", () => {
    const fx = makeFixture({ toplevel: "/wt/main/feature" });

    const exit = runHomeSync({ ...baseOpts, format: "json" }, fx.output, fx.deps);

    expect(exit).toBe(2);
    expect(fx.logs).toHaveLength(0);
    expect(fx.errs.join("\n")).toContain("must run from the mainx worktree");
  });
});

describe("runCli wiring for `home sync`", () => {
  test("routes to the injected homeSync handler with parsed flags", () => {
    const calls: Array<HomeSyncOptions> = [];

    const exit = runCli(
      [
        "home",
        "sync",
        "--flake-dir",
        "/custom/flake",
        "--input",
        "ai-home",
        "--dry-run",
        "--format",
        "json",
      ],
      { log: () => {}, error: () => {} },
      {
        homeSync: (options) => {
          calls.push(options);
          return 0;
        },
      },
    );

    expect(exit).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      flakeDir: "/custom/flake",
      input: "ai-home",
      dryRun: true,
      format: "json",
    });
  });

  test("returns the handler's exit code", () => {
    const exit = runCli(
      ["home", "sync"],
      { log: () => {}, error: () => {} },
      { homeSync: () => 7 },
    );
    expect(exit).toBe(7);
  });

  test("`prx home` (no subcommand) error message lists both update and sync", () => {
    const errs: string[] = [];
    const exit = runCli(
      ["home"],
      { log: () => {}, error: (e) => errs.push(e) },
    );
    expect(exit).not.toBe(0);
    expect(errs.join("\n")).toContain("update");
    expect(errs.join("\n")).toContain("sync");
  });
});
