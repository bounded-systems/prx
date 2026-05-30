// GH-1900: `prx submit session` parser + dispatch shape — work-unit-bound.

import { describe, expect, test } from "bun:test";

import { runCli } from "../../src/pr-state/cli.ts";
import type {
  RuntimeExecutionResult,
  RuntimeExecutor,
} from "../../src/pr-state/executor.ts";

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

const okExec: RuntimeExecutor = (): RuntimeExecutionResult => ({
  status: 0,
  stdout: "",
  stderr: "",
});

describe("prx submit session (GH-1900 work-unit-bound)", () => {
  test("missing positional → CliError with hint, non-zero exit", async () => {
    const { errors, output } = captureOutput();
    const exit = await runCli(["submit", "agent"], output, {});
    expect(exit).not.toBe(0);
    const hintLine = errors.find((line) =>
      line.includes("requires a <work-unit-id> positional"),
    );
    expect(hintLine).toBeDefined();
  });

  test("--check with no positional prints a work-unit-bound readiness line", async () => {
    const { logs, output } = captureOutput();
    const exit = await runCli(["submit", "agent", "--check"], output, {});
    expect(exit).toBe(0);
    expect(logs.some((line) => line.includes("submit agent: ready"))).toBe(true);
  });

  test("--check --format json emits a work-unit-bound readiness blob", async () => {
    const { logs, output } = captureOutput();
    const exit = await runCli(
      ["submit", "agent", "--check", "--format", "json"],
      output,
      {},
    );
    expect(exit).toBe(0);
    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0]!) as { profile: string; binding: string };
    expect(parsed.profile).toBe("submit");
    expect(parsed.binding).toBe("work-unit");
  });

  test("--dry-run with positional prints the runtime profile, skips spawn", async () => {
    const { logs, output } = captureOutput();
    let executorCalled = false;
    const trackingExec: RuntimeExecutor = (...args) => {
      executorCalled = true;
      return okExec(...args);
    };

    const exit = await runCli(
      ["submit", "agent", "GH-1767", "--dry-run", "--format", "json"],
      output,
      {
        ensureOpsRuntimeMcp: () => ({ mcpServers: [] }),
        execRuntime: trackingExec,
      },
    );

    expect(exit).toBe(0);
    expect(executorCalled).toBe(false);
    expect(logs.length).toBeGreaterThan(0);
    // The dry-run output is the resolved RuntimeProfileProjection JSON.
    const joined = logs.join("\n");
    expect(joined).toContain("\"command\": \"claude\"");
    expect(joined).toContain("\"PRX_AGENT_ROLE\": \"submit\"");
    expect(joined).toContain("\"PRX_SUBMIT_SESSION_UNIT\": \"GH-1767\"");
    // GH-2380: the default is the headless SDK profile.
    expect(joined).toContain("\"interaction\": \"headless\"");
    expect(joined).toContain("\"agentRuntime\": \"sdk\"");
    expect(joined).toContain("\"GH-1767\"");
    expect(joined).not.toContain("mainx-submit");
  });

  // GH-2380: hard-removed `session` token errors with a removal hint.
  test("`prx submit session` errors with the removal hint", async () => {
    const { errors, output } = captureOutput();
    const exit = await runCli(["submit", "session", "GH-1767"], output, {});
    expect(exit).not.toBe(0);
    expect(
      errors.some((line) => line.includes("prx submit session: removed; use prx submit agent")),
    ).toBe(true);
  });

  // GH-2380: --interactive opts into the legacy tmux/PTY profile.
  test("--interactive --dry-run prints the legacy tmux/PTY profile", async () => {
    const { logs, output } = captureOutput();
    const exit = await runCli(
      ["submit", "agent", "GH-1767", "--interactive", "--dry-run", "--format", "json"],
      output,
      { ensureOpsRuntimeMcp: () => ({ mcpServers: [] }) },
    );
    expect(exit).toBe(0);
    const joined = logs.join("\n");
    expect(joined).not.toContain("\"interaction\": \"headless\"");
    expect(joined).not.toContain("\"agentRuntime\": \"sdk\"");
    expect(joined).toContain("--name");
  });

  test("extra positionals rejected with hint", async () => {
    const { errors, output } = captureOutput();
    const exit = await runCli(
      ["submit", "agent", "GH-1767", "GH-1900"],
      output,
      {},
    );
    expect(exit).not.toBe(0);
    expect(
      errors.some((line) => line.includes("accepts a single work-unit id")),
    ).toBe(true);
  });

  test("invalid canonical id rejected", async () => {
    const { errors, output } = captureOutput();
    const exit = await runCli(["submit", "agent", "not-a-real-id"], output, {});
    expect(exit).not.toBe(0);
    expect(
      errors.some((line) => line.includes("CANONICAL-ID")),
    ).toBe(true);
  });
});
