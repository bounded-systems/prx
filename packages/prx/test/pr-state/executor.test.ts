import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

import {
  executeValidatedAgentWithRetry,
  localRuntimeExecutor,
  type RuntimeExecutor,
} from "../../src/pr-state/executor.ts";
import type { RuntimeProfileProjection } from "../../src/machine/runtime_profiles.ts";
import { resolveInteraction, resolveAgentBackend } from "../../src/machine/runtime_profiles.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function makeProfile(overrides: Partial<RuntimeProfileProjection> = {}): RuntimeProfileProjection {
  return {
    profile: "work-unit",
    mode: "full",
    command: process.execPath as RuntimeProfileProjection["command"],
    args: ["-e", 'console.log("executor-test-ok")'],
    trustTiers: {
      tierA_controlled: [],
      tierB_partial: [],
      tierC_ambient: [],
    },
    sourcesOfTruth: {
      agents: "inline_prompt",
      mcp: "project-only",
      plugins: [],
      connectors: [],
    },
    allowedActors: ["prx"],
    disallowedActors: [],
    notes: [],
    ...overrides,
  };
}

describe("runtime executor boundary", () => {
  test("validated executor retries until the executor returns contract-shaped JSON", () => {
    let attempts = 0;
    const executor: RuntimeExecutor = () => {
      attempts += 1;
      if (attempts === 1) {
        return { status: 0, stdout: "not-json", stderr: "" };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          status: "success",
          data: { echo: "ok" },
          meta: { latency_ms: 1 },
        }),
        stderr: "",
      };
    };

    const result = executeValidatedAgentWithRetry(makeProfile(), repoRoot, executor, 2);

    expect(result.attempts).toBe(2);
    expect(result.result.status).toBe("success");
    expect(result.result.data).toEqual({ echo: "ok" });
  });

  test("local runtime executor runs the selected runtime profile and captures stdout", () => {
    const result = localRuntimeExecutor(makeProfile(), "json", repoRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("executor-test-ok");
  });

  test("local runtime executor returns normalized failures from the runtime", () => {
    const result = localRuntimeExecutor(
      makeProfile({
        command: process.execPath as RuntimeProfileProjection["command"],
        args: ["-e", 'process.stderr.write("intentional test failure\\n"); process.exit(1);'],
      }),
      "json",
      repoRoot,
    );

    expect(result.status).not.toBe(0);
    expect((result.stderr || result.stdout).trim().length).toBeGreaterThan(0);
  });
});

describe("headless-first axis resolution", () => {
  test("explicit interaction wins over agentRuntime", () => {
    expect(resolveInteraction(makeProfile({ interaction: "headless" }))).toBe("headless");
    expect(
      resolveInteraction(makeProfile({ interaction: "interactive", agentRuntime: "sdk" })),
    ).toBe("interactive");
  });

  test("absent interaction derives from agentRuntime (back-compat)", () => {
    expect(resolveInteraction(makeProfile({ agentRuntime: "sdk" }))).toBe("headless");
    expect(resolveInteraction(makeProfile({ agentRuntime: "subprocess" }))).toBe("interactive");
    expect(resolveInteraction(makeProfile({}))).toBe("interactive");
  });

  test("backend is sdk only for headless claude; everything else is subprocess", () => {
    expect(resolveAgentBackend(makeProfile({ command: "claude", interaction: "headless" }))).toBe(
      "sdk",
    );
    // Pre-axis sdk profiles (agentRuntime only) still derive to the sdk backend.
    expect(resolveAgentBackend(makeProfile({ command: "claude", agentRuntime: "sdk" }))).toBe(
      "sdk",
    );
    // Headless non-claude agents stay subprocess (their --print mode).
    expect(resolveAgentBackend(makeProfile({ command: "codex", interaction: "headless" }))).toBe(
      "subprocess",
    );
    // Interactive claude is subprocess (tmux), not the SDK.
    expect(
      resolveAgentBackend(makeProfile({ command: "claude", interaction: "interactive" })),
    ).toBe("subprocess");
  });
});
