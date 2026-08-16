import { describe, expect, test } from "bun:test";

import { renderAgentDoctorPlain, runAgentDoctor } from "../../src/tools/agent_doctor.ts";

describe("agent_doctor", () => {
  test("marks agent healthy when version and ping succeed", async () => {
    const report = await runAgentDoctor(
      { agents: ["codex"], timeoutMs: 5000 },
      {
        which: () => "/tmp/codex",
        readBinarySha256: () => "deadbeef",
        run: (command) => {
          if (command[1] === "--version") {
            return { exitCode: 0, stdout: "codex-cli 0.120.0\n", stderr: "", latencyMs: 12 };
          }
          return { exitCode: 0, stdout: "pong\n", stderr: "", latencyMs: 40 };
        },
      },
    );

    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.healthy).toBeTrue();
    expect(report.results[0]?.errorType).toBeNull();
    expect(report.results[0]?.helpUrl).toBeNull();
    expect(report.results[0]?.binary.sha256).toBe("deadbeef");
    expect(report.results[0]?.version.output).toContain("codex-cli");
    expect(report.results[0]?.ping.output).toContain("pong");
  });

  test("marks agent unhealthy when binary is missing", async () => {
    const report = await runAgentDoctor(
      { agents: ["claude"] },
      {
        which: () => null,
        readBinarySha256: () => {
          throw new Error("should not be called");
        },
        run: () => {
          throw new Error("should not be called");
        },
      },
    );

    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.healthy).toBeFalse();
    expect(report.results[0]?.version.exitCode).toBe(127);
    expect(report.results[0]?.ping.exitCode).toBe(127);
    expect(report.results[0]?.errorType).toBe("config_error");
    expect(report.results[0]?.helpUrl).toContain("anthropic");
  });

  test("renders plain summary", async () => {
    const report = await runAgentDoctor(
      { agents: ["gemini"] },
      {
        which: () => "/tmp/gemini",
        readBinarySha256: () => "abc123",
        run: (command) => {
          if (command[1] === "--version") {
            return { exitCode: 0, stdout: "0.28.1\n", stderr: "", latencyMs: 1 };
          }
          return { exitCode: 1, stdout: "", stderr: "quota exceeded", latencyMs: 33 };
        },
      },
    );

    const text = renderAgentDoctorPlain(report);
    expect(text).toContain("agent-doctor");
    expect(text).toContain("gemini: unhealthy");
    expect(text).toContain("quota exceeded");
    expect(text).toContain("error: quota_error");
    expect(text).toContain("fix:");
  });
});
