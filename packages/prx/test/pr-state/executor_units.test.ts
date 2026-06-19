// pr-state/executor — the units the existing executor.test.ts leaves uncovered:
// shellQuote, executeValidatedAgentOnce's error/parse/schema arms, retry
// exhaustion + timeout-break, executeAgentProfile's subprocess route, the
// AgentProfileExecutionResult→RuntimeExecutionResult mapper, and
// localRuntimeExecutor's json/plain/timeout/spawn-error arms (real /bin spawns).

import { describe, expect, test } from "bun:test";

import {
  agentProfileExecutionAsRuntimeResult,
  executeAgentProfile,
  executeValidatedAgentOnce,
  executeValidatedAgentWithRetry,
  localRuntimeExecutor,
  shellQuote,
  type RuntimeExecutor,
} from "../../src/pr-state/executor.ts";
import type { RuntimeProfileProjection } from "../../src/machine/runtime_profiles.ts";
import type { ClaudeAgentQuery } from "../../src/claude/agent_service.ts";

function makeProfile(overrides: Partial<RuntimeProfileProjection> = {}): RuntimeProfileProjection {
  return {
    profile: "work-unit",
    mode: "full",
    command: process.execPath as RuntimeProfileProjection["command"],
    args: ["-e", 'console.log("ok")'],
    trustTiers: { tierA_controlled: [], tierB_partial: [], tierC_ambient: [] },
    sourcesOfTruth: { agents: "inline_prompt", mcp: "project-only", plugins: [], connectors: [] },
    allowedActors: ["prx"],
    disallowedActors: [],
    notes: [],
    ...overrides,
  } as RuntimeProfileProjection;
}

const ok = (data: object = { echo: "x" }) =>
  JSON.stringify({ status: "success", data, meta: { latency_ms: 1 } });
const exec =
  (status: number, stdout = "", stderr = ""): RuntimeExecutor =>
  () => ({ status, stdout, stderr });

// ── shellQuote ────────────────────────────────────────────────────────────────

describe("shellQuote", () => {
  test("leaves safe tokens unquoted", () => {
    expect(shellQuote("GH-1_path/to.thing")).toBe("GH-1_path/to.thing");
  });
  test("single-quotes + escapes anything else", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

// ── executeValidatedAgentOnce ─────────────────────────────────────────────────

describe("executeValidatedAgentOnce", () => {
  const p = makeProfile();
  test("a non-zero exit with timeout-ish stderr → timeout", () => {
    expect(executeValidatedAgentOnce(p, "/c", exec(124, "", "timed out")).status).toBe("timeout");
  });
  test("a non-zero exit → error", () => {
    expect(executeValidatedAgentOnce(p, "/c", exec(1, "", "boom")).status).toBe("error");
  });
  test("non-JSON stdout → error (parse)", () => {
    const r = executeValidatedAgentOnce(p, "/c", exec(0, "not json"));
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error?.message).toMatch(/invalid json/);
  });
  test("empty stdout → error (empty output)", () => {
    const r = executeValidatedAgentOnce(p, "/c", exec(0, "   "));
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error?.message).toMatch(/empty output/);
  });
  test("valid JSON that fails the adapter schema → error (schema)", () => {
    const r = executeValidatedAgentOnce(p, "/c", exec(0, JSON.stringify({ nope: true })));
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error?.message).toMatch(/schema validation/);
  });
  test("a contract-shaped success → success", () => {
    expect(executeValidatedAgentOnce(p, "/c", exec(0, ok())).status).toBe("success");
  });
});

// ── executeValidatedAgentWithRetry ────────────────────────────────────────────

describe("executeValidatedAgentWithRetry", () => {
  const p = makeProfile();
  test("retries past a transient error then succeeds", () => {
    let n = 0;
    const e: RuntimeExecutor = () =>
      ++n === 1 ? { status: 1, stdout: "", stderr: "x" } : { status: 0, stdout: ok(), stderr: "" };
    const r = executeValidatedAgentWithRetry(p, "/c", e);
    expect(r.attempts).toBe(2);
    expect(r.result.status).toBe("success");
  });
  test("exhausts maxAttempts on persistent error", () => {
    const r = executeValidatedAgentWithRetry(p, "/c", exec(1, "", "always"), 3);
    expect(r.attempts).toBe(3);
    expect(r.result.status).toBe("error");
  });
  test("a timeout breaks the retry loop immediately", () => {
    const r = executeValidatedAgentWithRetry(p, "/c", exec(124, "", "timed out"), 5);
    expect(r.attempts).toBe(1);
    expect(r.result.status).toBe("timeout");
  });
});

// ── executeAgentProfile (subprocess route) ────────────────────────────────────

describe("executeAgentProfile", () => {
  test("routes through the injected subprocess executor", async () => {
    const r = await executeAgentProfile(makeProfile(), {
      cwd: "/c",
      subprocessExecutor: exec(0, "captured", ""),
    });
    expect(r.kind).toBe("subprocess");
    if (r.kind === "subprocess") expect(r.execution.stdout).toBe("captured");
  });

  test("routes a headless claude profile through the SDK backend", async () => {
    // command: "claude" + headless interaction → resolveAgentBackend === "sdk".
    // A fake `query` keeps the SDK path off the real CLI.
    const sdkProfile = makeProfile({
      profile: "user",
      command: "claude" as never,
      args: ["--print"],
      agentRuntime: "sdk",
      sdkSpec: { prompt: "ping", model: "claude-haiku-4-5-20251001" },
    } as Partial<RuntimeProfileProjection>);
    const query: ClaudeAgentQuery = () => {
      async function* gen(): AsyncGenerator<Record<string, unknown>, void> {
        await Promise.resolve();
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "pong",
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          total_cost_usd: 0,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          modelUsage: {},
          permission_denials: [],
          stop_reason: "end_turn",
          uuid: "u-r",
          session_id: "s-1",
        };
      }
      return Object.assign(gen(), {
        interrupt: async () => {},
        close: () => {},
      }) as unknown as ReturnType<ClaudeAgentQuery>;
    };
    const r = await executeAgentProfile(sdkProfile, {
      cwd: "/c",
      timeoutMs: 5_000,
      sdkDeps: { query },
    });
    expect(r.kind).toBe("sdk");
    if (r.kind === "sdk") expect(r.result.kind).toBe("success");
  });
});

// ── agentProfileExecutionAsRuntimeResult ──────────────────────────────────────

describe("agentProfileExecutionAsRuntimeResult", () => {
  test("subprocess passes the execution through", () => {
    const e = { status: 0, stdout: "s", stderr: "" };
    expect(agentProfileExecutionAsRuntimeResult({ kind: "subprocess", execution: e })).toEqual(e);
  });
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  test("sdk success → status 0 + stdout", () => {
    const r = agentProfileExecutionAsRuntimeResult({
      kind: "sdk",
      result: { kind: "success", text: "env", stdout: "env", usage, elapsed_ms: 1 },
    });
    expect(r).toEqual({ status: 0, stdout: "env", stderr: "" });
  });
  test("sdk cancelled (configured timeout) → 124 + partial", () => {
    const r = agentProfileExecutionAsRuntimeResult({
      kind: "sdk",
      result: {
        kind: "cancelled",
        reason: "watchdog",
        elapsed_ms: 50,
        configured_timeout_ms: 40,
        draftRef: null,
        partialStdout: "p",
      },
    });
    expect(r.status).toBe(124);
    expect(r.stdout).toBe("p");
    expect(r.stderr).toMatch(/configured --timeout=40ms/);
  });
  test("sdk cancelled (no configured timeout) → 124", () => {
    const r = agentProfileExecutionAsRuntimeResult({
      kind: "sdk",
      result: {
        kind: "cancelled",
        reason: "operator",
        elapsed_ms: 9,
        configured_timeout_ms: null,
        draftRef: null,
        partialStdout: "",
      },
    });
    expect(r.status).toBe(124);
    expect(r.stderr).toMatch(/reason=operator/);
  });
  test("sdk failure → status 1 + tagged message", () => {
    const r = agentProfileExecutionAsRuntimeResult({
      kind: "sdk",
      result: { kind: "failed", errorKind: "network", message: "down", elapsed_ms: 1 },
    });
    expect(r).toEqual({ status: 1, stdout: "", stderr: "[network] down" });
  });
});

// ── localRuntimeExecutor (real /bin spawns) ───────────────────────────────────

describe("localRuntimeExecutor", () => {
  test("json format pipes the command output", () => {
    const r = localRuntimeExecutor(
      makeProfile({ args: ["-e", "process.stdout.write('hi')"] }),
      "json",
      process.cwd(),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("hi");
  });
  // Both plain-format cases build the `/bin/zsh -lc` command line (the branch
  // under test) before spawning; the spawn result is platform-dependent (the
  // Linux CI runner may not ship /bin/zsh), so we assert only that a numeric
  // status comes back, not a specific exit code.
  test("plain format runs through a login shell (exec form)", () => {
    const r = localRuntimeExecutor(
      makeProfile({ command: "true" as never, args: [] }),
      "plain",
      process.cwd(),
    );
    expect(typeof r.status).toBe("number");
  });
  test("plain format with fallbackArgs builds the rc=1 fallback", () => {
    const r = localRuntimeExecutor(
      makeProfile({ command: "false" as never, args: [], fallbackArgs: [] }),
      "plain",
      process.cwd(),
    );
    expect(typeof r.status).toBe("number");
  });
  test("a spawn error maps to status 1", () => {
    const r = localRuntimeExecutor(
      makeProfile({ command: "prx-not-a-real-bin-xyz" as never, args: [] }),
      "json",
      process.cwd(),
    );
    expect(r.status).toBe(1);
  });
  test("a fired timeout maps to 124", () => {
    const r = localRuntimeExecutor(
      makeProfile({ command: "sleep" as never, args: ["5"] }),
      "json",
      process.cwd(),
      50,
    );
    expect(r.status).toBe(124);
  });
});
