// GH-2280 Target 1: `prx submit agent` / `prx author agent` route the live
// open through the `session_open` actor (I-SO1) and spawn the agent in the
// reserved work-unit worktree — never the operator's cwd (the mainx-leak the
// GH-2027 epic exists to kill). Mirrors the shipped triage/intake routing tests.
// (The user-facing verb is `agent`; `session` was retired upstream.)

import { describe, expect, test } from "bun:test";

import { runCli } from "../../src/pr-state/cli.ts";
import { dispatchFromArgv } from "../../src/pr-state/session-entry/dispatch.ts";
import type { OpenSessionResult } from "../../src/session/open.ts";
import type { RuntimeExecutionResult, RuntimeExecutor } from "../../src/pr-state/executor.ts";

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

/** A fake openSession that records its input + returns a fixed worktree path. */
function fakeOpenSession(opts: {
  worktreePath: string;
  record?: (input: { actor: string; workUnitId?: string | undefined }) => void;
}) {
  return async (input: {
    actor: string;
    workUnitId?: string | undefined;
  }): Promise<OpenSessionResult> => {
    opts.record?.(input);
    return {
      workspace_id: "deadbeef0000",
      worktree_path: opts.worktreePath,
      branch_ref: input.workUnitId ?? "",
      lifecycle: "attached",
      reserved_status: "created",
      prepared_status: "ok",
      profile_built: true,
      status: "opened",
      profile: dispatchFromArgv([input.actor, "agent", input.workUnitId ?? "GH-1767"]),
    };
  };
}

/** A fake openSession that fails — e.g. the I-WS5 mainx-replica refusal. */
function failingOpenSession(
  error: string,
  stage: "naming" | "reserve" | "materialize" | "prepare" | "dispatch" = "materialize",
) {
  return async (): Promise<OpenSessionResult> => ({
    workspace_id: "deadbeef0000",
    worktree_path: "",
    branch_ref: "",
    lifecycle: "attached",
    reserved_status: "created",
    prepared_status: "error",
    profile_built: false,
    status: "error",
    stage,
    error,
  });
}

const okExec: RuntimeExecutor = (): RuntimeExecutionResult => ({
  status: 0,
  stdout: "",
  stderr: "",
});

for (const actor of ["submit", "author"] as const) {
  describe(`prx ${actor} session — openSession routing (GH-2280)`, () => {
    test("live open routes through openSession; spawns in the reserved worktree", async () => {
      const { output } = captureOutput();
      const worktreePath = "/tmp/reserved-worktree-GH-1767";
      let routedActor: string | null = null as string | null;
      let routedUnit: string | null = null as string | null;
      let allowlistCwd: string | null = null as string | null;
      let mcpCwd: string | null = null as string | null;
      let execCwd: string | null = null as string | null;

      const exit = await runCli([actor, "agent", "GH-1767"], output, {
        openSession: fakeOpenSession({
          worktreePath,
          record: (input) => {
            routedActor = input.actor;
            routedUnit = input.workUnitId ?? null;
          },
        }),
        ensureClaudeSessionAllowlist: (cwd) => {
          allowlistCwd = cwd ?? null;
          return { status: "created", path: `${cwd}/.claude/settings.local.json` };
        },
        ensureOpsRuntimeMcp: (cwd?: string) => {
          mcpCwd = cwd ?? null;
          return { mcpServers: [] };
        },
        execRuntime: (profile, mode, cwd, timeout) => {
          execCwd = cwd ?? null;
          return okExec(profile, mode, cwd, timeout);
        },
      });

      expect(exit).toBe(0);
      expect(routedActor).toBe(actor);
      expect(routedUnit).toBe("GH-1767");
      // I-SO1: every downstream side-effect targets the reserved worktree.
      expect(allowlistCwd).toBe(worktreePath);
      expect(mcpCwd).toBe(worktreePath);
      expect(execCwd).toBe(worktreePath);
    });

    test("--dry-run previews the profile without opening a session (no reserve)", async () => {
      const { logs, output } = captureOutput();
      let openSessionCalled = false;
      let executorCalled = false;

      const exit = await runCli(
        [actor, "agent", "GH-1767", "--dry-run", "--format", "json"],
        output,
        {
          openSession: async () => {
            openSessionCalled = true;
            throw new Error("dry-run must not open a session");
          },
          ensureOpsRuntimeMcp: () => ({ mcpServers: [] }),
          execRuntime: (...args) => {
            executorCalled = true;
            return okExec(...args);
          },
        },
      );

      expect(exit).toBe(0);
      expect(openSessionCalled).toBe(false);
      expect(executorCalled).toBe(false);
      const joined = logs.join("\n");
      expect(joined).toContain('"command": "claude"');
    });

    test("--check confirms readiness without opening a session", async () => {
      const { logs, output } = captureOutput();
      let openSessionCalled = false;
      const exit = await runCli([actor, "agent", "--check"], output, {
        openSession: async () => {
          openSessionCalled = true;
          throw new Error("--check must not open a session");
        },
      });
      expect(exit).toBe(0);
      expect(openSessionCalled).toBe(false);
      expect(logs.some((line) => line.includes(`${actor} agent: ready`))).toBe(true);
    });

    test("openSession error (I-WS5 mainx refusal) returns non-zero, no spawn", async () => {
      const { errors, output } = captureOutput();
      let executorCalled = false;
      const exit = await runCli([actor, "agent", "GH-1767"], output, {
        openSession: failingOpenSession(
          "refusing to operate on read-only mainx replica — materialize a sibling worktree first",
        ),
        execRuntime: (...args) => {
          executorCalled = true;
          return okExec(...args);
        },
      });
      expect(exit).toBe(1);
      expect(executorCalled).toBe(false);
      expect(errors.some((line) => line.includes("session-open failed"))).toBe(true);
    });
  });
}
