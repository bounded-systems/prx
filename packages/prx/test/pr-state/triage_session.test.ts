// Tests for `prx triage session` (GH-893): the unit-less ops Claude session
// pinned to mainx. The CLI seam is `runCli(argv, output, deps)`, which lets
// us inject the mainx detector, the triage-status reader, the MCP
// provisioner, and the runtime executor — no real spawn or git is touched.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { runCli } from "../../src/pr-state/cli.ts";
import type { RuntimeExecutionResult, RuntimeExecutor } from "../../src/pr-state/executor.ts";
import type { TriageStatusResult } from "../../src/triage/triage.ts";
import type { ResolveTargetRepoResult } from "../../src/pr-state/repo-target.ts";
import type { LocalRepo } from "../../src/pr-state/repos.ts";
import { dispatchFromArgv } from "../../src/pr-state/session-entry/dispatch.ts";
import type { OpenSessionResult } from "../../src/session/open.ts";

/**
 * GH-2258: the live `prx triage session` path now routes through the
 * `session_open` actor (I-SO1) and spawns at the reserved ephemeral
 * worktree. Tests inject this fake so no real worktree is reserved; it
 * records the routed actor + reserve-base cwd and returns a real
 * session-entry profile (the same one `openSession` builds internally)
 * so downstream profile assertions stay meaningful.
 */
/** A real, writable ephemeral dir to stand in for the reserved worktree
 *  (the live path writes `.pr/local/runtime/executions.log.jsonl` there). */
function tmpWorktree(): string {
  return mkdtempSync(join(tmpdir(), "prx-triage-wt-"));
}

function fakeOpenSession(opts: {
  worktreePath: string;
  record?: (input: { actor: string }, cwd: string | undefined) => void;
}) {
  return async (
    input: {
      actor: string;
      workUnitId?: string | undefined;
      interaction?: "headless" | "interactive";
    },
    deps?: { cwd?: () => string },
  ): Promise<OpenSessionResult> => {
    opts.record?.(input, deps?.cwd?.());
    // GH-2380: honor the headless-first axis the handler forwards.
    const profile = dispatchFromArgv([
      input.actor,
      "agent",
      ...(input.interaction === "interactive" ? ["--interactive"] : []),
    ]);
    return {
      workspace_id: "deadbeef0000",
      worktree_path: opts.worktreePath,
      branch_ref: `${input.actor}/20260526-abc123`,
      lifecycle: "materialized",
      reserved_status: "created",
      prepared_status: "ok",
      profile_built: true,
      status: "opened",
      profile,
    };
  };
}

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

function captureOutput(): { logs: string[]; errors: string[]; output: Output } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    output: {
      log: (line: string) => logs.push(line),
      error: (line: string) => errors.push(line),
    },
  };
}

function fakeQueueResult(): TriageStatusResult {
  return {
    repo: "bdelanghe/ai-home",
    canonical: "gh",
    totalOpen: 47,
    totalUntriaged: 12,
    totalReverseOrphans: 0,
    totalDrift: 0,
    totalStale: 0,
    totalAxisConflicts: 0,
    issues: [],
    reverseOrphans: [],
    drift: [],
    stale: [],
    axisConflicts: [],
  };
}

function fakeRunTriageStatus(result: TriageStatusResult) {
  return (_opts: unknown, output: Output): number => {
    output.log(JSON.stringify(result));
    return 0;
  };
}

describe("prx triage session (GH-893)", () => {
  test("GH-2258: routes through session_open and spawns at the reserved worktree (no mainx guard)", async () => {
    const { errors, output } = captureOutput();
    const worktreePath = tmpWorktree();
    let routedActor: string | undefined;
    let reserveBaseCwd: string | undefined;
    let executorCwd: string | undefined;
    let allowlistCwd: string | undefined;
    const fakeExec: RuntimeExecutor = (_profile, _mode, cwd): RuntimeExecutionResult => {
      executorCwd = cwd;
      return { status: 0, stdout: "", stderr: "" };
    };

    const exit = await runCli(["triage", "agent"], output, {
      // The mainx guard is gone — a false detector must NOT reject anymore.
      isMainxWorktree: () => false,
      runTriageStatus: fakeRunTriageStatus(fakeQueueResult()),
      openSession: fakeOpenSession({
        worktreePath,
        record: (input, cwd) => {
          routedActor = input.actor;
          reserveBaseCwd = cwd;
        },
      }),
      ensureOpsRuntimeMcp: () => ({ mcpServers: [] }),
      ensureClaudeSessionAllowlist: (cwd) => {
        allowlistCwd = cwd;
        return { status: "created", path: `${cwd}/.claude/settings.local.json` };
      },
      execRuntime: fakeExec,
    });

    expect(exit).toBe(0);
    // I-SO1: routed through session_open with actor "triage".
    expect(routedActor).toBe("triage");
    // Reserve base cwd is supplied (the canonical/queue cwd).
    expect(typeof reserveBaseCwd).toBe("string");
    // Spawns at the reserved ephemeral worktree, not the invocation cwd.
    expect(executorCwd).toBe(worktreePath);
    expect(allowlistCwd).toBe(worktreePath);
    // The old mainx guard error must not appear.
    expect(errors.some((line) => line.includes("must run from a mainx worktree"))).toBe(false);
  });

  test("GH-2258: session-open failure fails closed (non-zero, no spawn)", async () => {
    const { errors, output } = captureOutput();
    let executorCalled = false;
    const fakeExec: RuntimeExecutor = (): RuntimeExecutionResult => {
      executorCalled = true;
      return { status: 0, stdout: "", stderr: "" };
    };

    const exit = await runCli(["triage", "agent"], output, {
      runTriageStatus: fakeRunTriageStatus(fakeQueueResult()),
      openSession: async () => ({
        workspace_id: "000000000000",
        worktree_path: "",
        branch_ref: "triage/20260526-abc123",
        lifecycle: "materialized",
        reserved_status: "error",
        prepared_status: "error",
        profile_built: false,
        status: "error",
        stage: "reserve",
        error: "ensureBranch returned error",
      }),
      ensureOpsRuntimeMcp: () => ({ mcpServers: [] }),
      execRuntime: fakeExec,
    });

    expect(exit).not.toBe(0);
    expect(executorCalled).toBe(false);
    expect(errors.some((line) => line.includes("session-open failed at reserve"))).toBe(true);
  });

  test("--check prints the queue summary without spawning claude or reserving", async () => {
    const { logs, output } = captureOutput();
    let executorCalled = false;
    let allowlistCalled = false;
    let openSessionCalled = false;
    const fakeExec: RuntimeExecutor = (): RuntimeExecutionResult => {
      executorCalled = true;
      return { status: 0, stdout: "", stderr: "" };
    };

    const exit = await runCli(["triage", "agent", "--check"], output, {
      runTriageStatus: fakeRunTriageStatus(fakeQueueResult()),
      openSession: async () => {
        openSessionCalled = true;
        throw new Error("--check must not reserve a worktree");
      },
      ensureOpsRuntimeMcp: () => ({ mcpServers: [] }),
      ensureClaudeSessionAllowlist: () => {
        allowlistCalled = true;
        return { status: "unchanged", path: "/tmp/.claude/settings.local.json" };
      },
      execRuntime: fakeExec,
    });

    expect(exit).toBe(0);
    expect(executorCalled).toBe(false);
    // GH-2258: --check is a read-only probe — it must not reserve.
    expect(openSessionCalled).toBe(false);
    // GH-1545: --check is a readiness probe — it must not touch settings.
    expect(allowlistCalled).toBe(false);
    expect(
      logs.some((line) =>
        line.includes("triage queue: 12 untriaged of 47 open issues in bdelanghe/ai-home"),
      ),
    ).toBe(true);
  });

  test("--check --format json from mainx emits the raw triage JSON", async () => {
    const { logs, output } = captureOutput();
    const queue = fakeQueueResult();

    const exit = await runCli(["triage", "agent", "--check", "--format", "json"], output, {
      isMainxWorktree: () => true,
      runTriageStatus: fakeRunTriageStatus(queue),
      ensureOpsRuntimeMcp: () => ({ mcpServers: [] }),
    });

    expect(exit).toBe(0);
    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0]!) as TriageStatusResult;
    expect(parsed).toEqual(queue);
  });

  test("--dry-run prints the runtime profile, skips spawn/MCP, and reserves nothing", async () => {
    const { logs, output } = captureOutput();
    let executorCalled = false;
    let mcpProvisionCalled = false;
    let allowlistCalled = false;
    let openSessionCalled = false;
    const fakeExec: RuntimeExecutor = (): RuntimeExecutionResult => {
      executorCalled = true;
      return { status: 0, stdout: "", stderr: "" };
    };

    const exit = await runCli(["triage", "agent", "--dry-run", "--format", "json"], output, {
      runTriageStatus: fakeRunTriageStatus(fakeQueueResult()),
      openSession: async () => {
        openSessionCalled = true;
        throw new Error("--dry-run must not reserve a worktree");
      },
      ensureOpsRuntimeMcp: () => {
        mcpProvisionCalled = true;
        return { mcpServers: [] };
      },
      ensureClaudeSessionAllowlist: () => {
        allowlistCalled = true;
        return { status: "unchanged", path: "/tmp/.claude/settings.local.json" };
      },
      execRuntime: fakeExec,
    });

    expect(exit).toBe(0);
    expect(executorCalled).toBe(false);
    expect(mcpProvisionCalled).toBe(false);
    // GH-2258: --dry-run is a preview — it must not reserve a worktree.
    expect(openSessionCalled).toBe(false);
    // GH-1545: --dry-run prints the projection and exits before any write.
    expect(allowlistCalled).toBe(false);
    const profile = JSON.parse(logs[logs.length - 1]!) as {
      command: string;
      args: string[];
      env?: Record<string, string>;
    };
    expect(profile.command).toBe("claude");
    // GH-2380: the default is the headless SDK profile (no tmux `--name`).
    const profileFull = JSON.parse(logs[logs.length - 1]!) as {
      command: string;
      args: string[];
      interaction?: string;
      agentRuntime?: string;
      env?: Record<string, string>;
    };
    expect(profileFull.interaction).toBe("headless");
    expect(profileFull.agentRuntime).toBe("sdk");
    expect(profile.args).not.toContain("--name");
    const permIdx = profile.args.indexOf("--permission-mode");
    expect(profile.args[permIdx + 1]).toBe("acceptEdits"); // prx-hz1: headless never uses plan mode
    expect(profile.env?.PRX_AGENT_ROLE).toBe("triage");
  });

  test("--interactive --dry-run prints the legacy tmux/PTY ops-triage profile (GH-2380)", async () => {
    const { logs, output } = captureOutput();
    const exit = await runCli(
      ["triage", "agent", "--interactive", "--dry-run", "--format", "json"],
      output,
      {
        runTriageStatus: fakeRunTriageStatus(fakeQueueResult()),
        openSession: async () => {
          throw new Error("--dry-run must not reserve a worktree");
        },
      },
    );
    expect(exit).toBe(0);
    const profile = JSON.parse(logs[logs.length - 1]!) as {
      command: string;
      args: string[];
      interaction?: string;
      agentRuntime?: string;
    };
    expect(profile.command).toBe("claude");
    // Interactive opt-in → no headless axis; legacy `--name` tmux shape.
    expect(profile.interaction).toBeUndefined();
    expect(profile.agentRuntime).toBeUndefined();
    const nameIdx = profile.args.indexOf("--name");
    expect(profile.args[nameIdx + 1]).toBe("mainx-triage");
  });

  test("the live session spawns the runtime executor with the ops-triage profile", async () => {
    const { output } = captureOutput();
    let captured: { command?: string; args?: string[]; interaction?: string | undefined } = {};
    const allowlistCalls: Array<[string, string]> = [];
    const fakeExec: RuntimeExecutor = (profile): RuntimeExecutionResult => {
      captured = {
        command: profile.command,
        args: [...profile.args],
        interaction: profile.interaction,
      };
      return { status: 0, stdout: "", stderr: "" };
    };

    const exit = await runCli(["triage", "agent"], output, {
      runTriageStatus: fakeRunTriageStatus(fakeQueueResult()),
      openSession: fakeOpenSession({ worktreePath: tmpWorktree() }),
      ensureOpsRuntimeMcp: () => ({ mcpServers: [] }),
      ensureClaudeSessionAllowlist: (cwd, profile) => {
        allowlistCalls.push([cwd, profile]);
        return { status: "created", path: `${cwd}/.claude/settings.local.json` };
      },
      execRuntime: fakeExec,
    });

    expect(exit).toBe(0);
    expect(captured.command).toBe("claude");
    // GH-2380: default is the headless SDK profile, routed through
    // executeAgentProfile's subprocess seam (deps.execRuntime).
    expect(captured.interaction).toBe("headless");
    const args = captured.args ?? [];
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits"); // prx-hz1
    expect(args).toContain("--print");
    // Ops session is unbound; no GH-N appears in args.
    expect(args.join(" ")).not.toMatch(/GH-\d+/);
    // GH-1545: launch pre-approves the triage profile's own Bash(…) verbs.
    expect(allowlistCalls.length).toBe(1);
    expect(allowlistCalls[0]![1]).toBe("triage");
    expect(typeof allowlistCalls[0]![0]).toBe("string");
  });

  test("never emits a Beads MCP advisory — no beads MCP server is provisioned (GH-1587)", async () => {
    const { errors, output } = captureOutput();
    let executorCalled = false;
    const fakeExec: RuntimeExecutor = (): RuntimeExecutionResult => {
      executorCalled = true;
      return { status: 0, stdout: "", stderr: "" };
    };

    const exit = await runCli(["triage", "agent"], output, {
      runTriageStatus: fakeRunTriageStatus(fakeQueueResult()),
      openSession: fakeOpenSession({ worktreePath: tmpWorktree() }),
      ensureOpsRuntimeMcp: () => ({ mcpServers: [] }),
      ensureClaudeSessionAllowlist: () => ({
        status: "unchanged",
        path: "/tmp/.claude/settings.local.json",
      }),
      execRuntime: fakeExec,
    });

    expect(exit).toBe(0);
    expect(executorCalled).toBe(true);
    expect(errors.some((line) => line.includes("Beads MCP"))).toBe(false);
  });

  test("--repo <slug> reads the queue at the target and reserves against it; spawns at the worktree (GH-1689/GH-2258)", async () => {
    const { output } = captureOutput();
    const targetCwd = mkdtempSync(join(tmpdir(), "prx-triage-session-repo-target-"));
    const worktreePath = tmpWorktree();
    const fakeRepo: LocalRepo = {
      name: "foo",
      commonDir: "/scratch/bare/foo.git",
      kind: "bare",
      mainWorktree: targetCwd,
      worktrees: [],
      localOnlyBranches: [],
      findings: [],
      remotes: [],
      primaryRemote: {
        name: "origin",
        url: "git@github.com:owner/foo.git",
        githubRepo: "owner/foo",
      },
      upstreamRemote: null,
    };
    let executorCwd: string | undefined;
    let allowlistCwd: string | undefined;
    let triageStatusCwd: string | undefined;
    let reserveBaseCwd: string | undefined;
    const fakeExec: RuntimeExecutor = (_profile, _mode, cwd): RuntimeExecutionResult => {
      executorCwd = cwd;
      return { status: 0, stdout: "", stderr: "" };
    };

    const exit = await runCli(["triage", "agent", "--repo", "foo"], output, {
      resolveTargetRepoCwd: (input): ResolveTargetRepoResult => {
        expect(input.slug).toBe("foo");
        return { targetCwd, repo: fakeRepo, materialize: null };
      },
      runTriageStatus: (_opts, out, statusDeps) => {
        triageStatusCwd = statusDeps?.cwd?.();
        out.log(JSON.stringify(fakeQueueResult()));
        return 0;
      },
      openSession: fakeOpenSession({
        worktreePath,
        record: (_input, cwd) => {
          reserveBaseCwd = cwd;
        },
      }),
      ensureOpsRuntimeMcp: () => ({ mcpServers: [] }),
      ensureClaudeSessionAllowlist: (cwd) => {
        allowlistCwd = cwd;
        return { status: "created", path: `${cwd}/.claude/settings.local.json` };
      },
      execRuntime: fakeExec,
    });

    expect(exit).toBe(0);
    // The queue read and the reserve base both target the resolved repo cwd.
    expect(triageStatusCwd).toBe(targetCwd);
    expect(reserveBaseCwd).toBe(targetCwd);
    // The spawn lands on the reserved ephemeral worktree (off the target's origin/main).
    expect(executorCwd).toBe(worktreePath);
    expect(allowlistCwd).toBe(worktreePath);
  });

  test("--repo <unknown> surfaces the `prx repo add` hint (GH-1689)", async () => {
    const { errors, output } = captureOutput();

    const exit = await runCli(
      ["triage", "agent", "--repo", "not-a-real-slug", "--dry-run"],
      output,
      {
        loadRepoInventoryConfig: () => ({
          repoRoot: null,
          bareRoot: null,
          roots: [],
          everywhereRoots: [],
          globalConfigPath: null,
          configPath: null,
          indexPath: null,
        }),
        discoverLocalRepos: () => ({ roots: [], repos: [] }),
        runTriageStatus: () => 0,
        ensureOpsRuntimeMcp: () => ({ mcpServers: [] }),
      },
    );

    expect(exit).not.toBe(0);
    const joined = errors.join("\n");
    expect(joined).toContain("not-a-real-slug");
    expect(joined).toContain("prx repo add");
  });

  test("surfaces a malformed-allowlist warning but still launches (GH-1545)", async () => {
    const { errors, output } = captureOutput();
    let executorCalled = false;
    const fakeExec: RuntimeExecutor = (): RuntimeExecutionResult => {
      executorCalled = true;
      return { status: 0, stdout: "", stderr: "" };
    };

    const exit = await runCli(["triage", "agent"], output, {
      runTriageStatus: fakeRunTriageStatus(fakeQueueResult()),
      openSession: fakeOpenSession({ worktreePath: tmpWorktree() }),
      ensureOpsRuntimeMcp: () => ({ mcpServers: [] }),
      ensureClaudeSessionAllowlist: () => ({
        status: "skipped-malformed",
        path: "/repo/.claude/settings.local.json",
      }),
      execRuntime: fakeExec,
    });

    expect(exit).toBe(0);
    expect(executorCalled).toBe(true);
    expect(errors.some((line) => line.includes("/repo/.claude/settings.local.json"))).toBe(true);
    expect(errors.some((line) => line.includes("may prompt for permission"))).toBe(true);
  });
});
