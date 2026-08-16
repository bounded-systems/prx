// tools/agent_doctor — classifyError categorisation, truncate's long-output
// branch, and the readBinarySha256-throw arm, driven through runAgentDoctor's
// injected deps (a codex probe whose ping fails with a category keyword). The
// real-spawn defaults (defaultDeps.run / defaultClaudeProbeRunner) are
// integration boundaries left to the live `prx agent doctor`.

import { describe, expect, test } from "bun:test";

import { runAgentDoctor } from "../../src/tools/agent_doctor.ts";

type CmdResult = { exitCode: number; stdout: string; stderr: string; latencyMs: number };

// version succeeds; ping fails with `pingOutput` so the result is unhealthy and
// classifyError runs on the ping output.
function depsWithPing(pingOutput: string, pingExit = 1) {
  return {
    which: () => "/bin/codex",
    readBinarySha256: () => "deadbeef",
    run: (command: readonly string[]): CmdResult => {
      const joined = command.join(" ");
      if (joined.includes("--version"))
        return { exitCode: 0, stdout: "codex 1.2.3", stderr: "", latencyMs: 1 };
      return { exitCode: pingExit, stdout: pingOutput, stderr: "", latencyMs: 1 };
    },
  };
}

async function errorTypeFor(pingOutput: string): Promise<string | null> {
  const report = await runAgentDoctor({ agents: ["codex"] }, depsWithPing(pingOutput));
  return report.results[0]!.errorType;
}

describe("classifyError (via runAgentDoctor)", () => {
  test("quota / billing / 402 / 429 → quota_error", async () => {
    expect(await errorTypeFor("HTTP 402: quota exceeded")).toBe("quota_error");
  });
  test("401 / unauthorized / invalid api key / auth → auth_error", async () => {
    expect(await errorTypeFor("401 Unauthorized: invalid api key")).toBe("auth_error");
  });
  test("permission / approval / sandbox → permission_error", async () => {
    expect(await errorTypeFor("permission denied in sandbox")).toBe("permission_error");
  });
  test("modelnotfound / unknown model / not found → config_error", async () => {
    expect(await errorTypeFor("ModelNotFound: cannot use this model")).toBe("config_error");
  });
  test("network / econn / timed out / dns → network_error", async () => {
    expect(await errorTypeFor("ECONNRESET: network unreachable")).toBe("network_error");
  });
  test("anything else → unknown_error", async () => {
    expect(await errorTypeFor("something weird happened")).toBe("unknown_error");
  });
});

describe("runAgentDoctor — output handling", () => {
  test("a >300-char ping output is truncated with an ellipsis", async () => {
    const long = "x".repeat(400);
    const report = await runAgentDoctor({ agents: ["codex"] }, depsWithPing(long));
    expect(report.results[0]!.ping.output.endsWith("...")).toBe(true);
    expect(report.results[0]!.ping.output.length).toBeLessThan(long.length);
  });

  test("a thrown readBinarySha256 leaves sha256 null but still probes", async () => {
    const report = await runAgentDoctor(
      { agents: ["codex"] },
      {
        which: () => "/bin/codex",
        readBinarySha256: () => {
          throw new Error("read failed");
        },
        run: (command: readonly string[]): CmdResult =>
          command.join(" ").includes("--version")
            ? { exitCode: 0, stdout: "codex 1", stderr: "", latencyMs: 1 }
            : { exitCode: 0, stdout: "OK", stderr: "", latencyMs: 1 },
      },
    );
    expect(report.results[0]!.binary.sha256).toBeNull();
    expect(report.results[0]!.healthy).toBe(true);
  });
});
