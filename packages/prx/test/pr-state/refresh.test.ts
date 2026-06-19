import { describe, expect, test } from "bun:test";

import { runCli, selectRefreshExecutionMode } from "../../src/pr-state/cli.ts";
import { prxCommandRegistry } from "../../src/cli/registry.data.ts";

function captureOutput() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    output: {
      log: (line: string) => lines.push(line),
      error: (line: string) => errors.push(line),
    },
    lines,
    errors,
  };
}

const mockPr = { number: 42, isDraft: false };

describe("selectRefreshExecutionMode", () => {
  test("returns local when --local flag is set", () => {
    expect(
      selectRefreshExecutionMode({
        local: true,
        noPush: false,
        pr: mockPr,
        headSha: "abc",
        remoteSha: "abc",
      }),
    ).toBe("local");
  });

  test("returns local when --no-push flag is set", () => {
    expect(
      selectRefreshExecutionMode({
        local: false,
        noPush: true,
        pr: mockPr,
        headSha: "abc",
        remoteSha: "abc",
      }),
    ).toBe("local");
  });

  test("returns local when no PR found", () => {
    expect(
      selectRefreshExecutionMode({
        local: false,
        noPush: false,
        pr: null,
        headSha: null,
        remoteSha: null,
      }),
    ).toBe("local");
  });

  test("returns local when HEAD differs from remote (local commits not yet pushed)", () => {
    expect(
      selectRefreshExecutionMode({
        local: false,
        noPush: false,
        pr: mockPr,
        headSha: "abc",
        remoteSha: "def",
      }),
    ).toBe("local");
  });

  test("returns local when remote SHA is null", () => {
    expect(
      selectRefreshExecutionMode({
        local: false,
        noPush: false,
        pr: mockPr,
        headSha: "abc",
        remoteSha: null,
      }),
    ).toBe("local");
  });

  test("returns server when PR exists and HEAD matches remote", () => {
    expect(
      selectRefreshExecutionMode({
        local: false,
        noPush: false,
        pr: mockPr,
        headSha: "abc123",
        remoteSha: "abc123",
      }),
    ).toBe("server");
  });
});

describe("prx worktree refresh (GH-1166)", () => {
  test("worktree refresh is registered in the command registry", () => {
    // GH-1166 retired the bare-session namespace; the canonical home for
    // the rebase-onto-origin-main verb is now `prx worktree refresh`.
    const found = prxCommandRegistry.find((c) => c.name === "worktree refresh");
    expect(found).toBeDefined();
    expect(found!.parent).toBe("worktree");
    expect(found!.binding).toBe("work-unit");
  });

  test("worktree refresh appears in help-all output", () => {
    const { output, lines } = captureOutput();
    const code = runCli(["help-all"], output);
    expect(code).toBe(0);
    const fullOutput = lines.join("\n");
    expect(fullOutput).toContain("prx worktree refresh");
  });

  test("parses worktree refresh with --format json", () => {
    const { output, errors } = captureOutput();
    runCli(["worktree", "refresh", "--format", "json"], output);
    const errorOutput = errors.join("\n");
    expect(errorOutput).not.toContain("Unknown worktree subcommand");
  });

  test("parses worktree refresh with --no-push", () => {
    const { output, errors } = captureOutput();
    runCli(["worktree", "refresh", "--no-push"], output);
    const errorOutput = errors.join("\n");
    expect(errorOutput).not.toContain("Unknown worktree subcommand");
  });

  test("parses worktree refresh with --local", () => {
    const { output, errors } = captureOutput();
    runCli(["worktree", "refresh", "--local"], output);
    const errorOutput = errors.join("\n");
    expect(errorOutput).not.toContain("Unknown worktree subcommand");
  });

  test("retired `prx session refresh` errors with redirect to worktree refresh", () => {
    const { output, errors } = captureOutput();
    const code = runCli(["session", "refresh"], output);
    expect(code).not.toBe(0);
    const errorOutput = errors.join("\n");
    expect(errorOutput).toContain("prx session refresh is retired");
    expect(errorOutput).toContain("prx worktree refresh");
  });
});
