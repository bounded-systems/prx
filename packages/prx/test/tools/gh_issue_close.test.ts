import { beforeEach, describe, expect, test } from "bun:test";
import {
  buildGhIssueCloseArgs,
  execGhIssueClose,
  formatGhIssueCloseResult,
  type GhIssueCloseSpawn,
} from "../../src/tools/gh_issue_close.ts";
import {
  __resetRateLimitCacheForTesting,
  configureRateLimit,
  type RateLimitDeps,
} from "@bounded-systems/github-budget";
import type { CommandResult } from "../../src/pr-state/github.ts";

beforeEach(() => {
  __resetRateLimitCacheForTesting();
  configureRateLimit({});
});

describe("buildGhIssueCloseArgs", () => {
  test("emits issue/close/N + default --reason duplicate", () => {
    expect(buildGhIssueCloseArgs({ number: 42 })).toEqual([
      "issue",
      "close",
      "42",
      "--reason",
      "duplicate",
    ]);
  });

  test("forwards explicit --reason and --repo", () => {
    expect(buildGhIssueCloseArgs({ number: 42, reason: "completed", repo: "o/r" })).toEqual([
      "issue",
      "close",
      "42",
      "--reason",
      "completed",
      "--repo",
      "o/r",
    ]);
  });

  test("accepts the duplicate state-reason value", () => {
    expect(buildGhIssueCloseArgs({ number: 7, reason: "duplicate" })).toEqual([
      "issue",
      "close",
      "7",
      "--reason",
      "duplicate",
    ]);
  });

  test("passes 'not planned' (space form) through unchanged to gh argv", () => {
    expect(buildGhIssueCloseArgs({ number: 9, reason: "not planned" })).toEqual([
      "issue",
      "close",
      "9",
      "--reason",
      "not planned",
    ]);
  });
});

describe("execGhIssueClose", () => {
  test("captures stdout/stderr and exit 0 on success", () => {
    const spawn: GhIssueCloseSpawn = (file, args) => {
      expect(file).toBe("gh");
      expect(args[0]).toBe("issue");
      expect(args[1]).toBe("close");
      expect(args[2]).toBe("100");
      return {
        status: 0,
        stdout: "Closed issue #100\n",
        stderr: "",
      };
    };
    const result = execGhIssueClose(
      { number: 100, reason: "not planned" },
      { HOME: "/tmp" },
      spawn,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Closed issue #100\n");
    expect(result.stderr).toBe("");
  });

  test("propagates non-zero exit and stderr from gh", () => {
    const spawn: GhIssueCloseSpawn = () => ({
      status: 2,
      stdout: "",
      stderr: "gh: not found\n",
    });
    const result = execGhIssueClose({ number: 100 }, { HOME: "/tmp" }, spawn);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("gh: not found\n");
  });

  test("status null is normalized to exit 1", () => {
    const spawn: GhIssueCloseSpawn = () => ({
      status: null,
      stdout: "",
      stderr: "",
      error: new Error("ENOENT"),
    });
    const result = execGhIssueClose({ number: 1 }, { HOME: "/tmp" }, spawn);
    expect(result.exitCode).toBe(1);
  });

  test("rate-limit gate exhaustion path returns budgetError with exit 1", () => {
    // Pre-stuff the rate-limit cache via a fake rawRunner so the gate sees
    // core=0/remaining and short-circuits before the spawn runs.
    const rawRunner = (cmd: string[]): CommandResult => {
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "rate_limit") {
        return {
          stdout: JSON.stringify({
            resources: {
              core: { limit: 5000, remaining: 0, reset: 9_999_999 },
              graphql: { limit: 5000, remaining: 5000, reset: 9_999_999 },
              search: { limit: 30, remaining: 30, reset: 9_999_999 },
            },
          }),
          stderr: "",
          status: 0,
        };
      }
      return { stdout: "", stderr: "", status: 0 };
    };
    const deps: RateLimitDeps = {
      rawRunner,
      now: () => new Date(1_000_000),
      auditPath: () => null,
      appendAuditLine: () => {},
      ensureDir: () => {},
    };
    configureRateLimit(deps);

    let spawnCalls = 0;
    const spawn: GhIssueCloseSpawn = () => {
      spawnCalls++;
      return { status: 0, stdout: "", stderr: "" };
    };

    const result = execGhIssueClose({ number: 99 }, { HOME: "/tmp" }, spawn);

    expect(result.budgetError).toBeDefined();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("gh-issue-close");
    expect(spawnCalls).toBe(0);
  });
});

describe("formatGhIssueCloseResult", () => {
  test("plain success returns trimmed stdout", () => {
    expect(
      formatGhIssueCloseResult({ exitCode: 0, stdout: "Closed issue #100\n", stderr: "" }, "plain"),
    ).toBe("Closed issue #100");
  });

  test("plain failure returns stderr", () => {
    expect(formatGhIssueCloseResult({ exitCode: 1, stdout: "", stderr: "boom\n" }, "plain")).toBe(
      "boom",
    );
  });

  test("json format is valid JSON", () => {
    const json = JSON.parse(
      formatGhIssueCloseResult({ exitCode: 0, stdout: "ok", stderr: "" }, "json"),
    ) as { exitCode: number; stdout: string };
    expect(json.exitCode).toBe(0);
    expect(json.stdout).toBe("ok");
  });
});
