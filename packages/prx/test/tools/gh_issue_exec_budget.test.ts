// The gh issue-write trio (edit/create/close) share one structure: an
// injectable spawn plus a rate-limit gate/recorder around it. Their existing
// tests cover the pure argv builders + happy path; this fills the remaining
// branches — both BucketBudgetExhausted paths, the non-budget rethrow, the
// default spawn wrapper, and the format json arm — for all three at once.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  execGhIssueEdit,
  formatGhIssueEditResult,
  type GhIssueEditSpawn,
} from "../../src/tools/gh_issue_edit.ts";
import {
  execGhIssueCreate,
  formatGhIssueCreateResult,
} from "../../src/tools/gh_issue_create.ts";
import {
  execGhIssueClose,
  formatGhIssueCloseResult,
} from "../../src/tools/gh_issue_close.ts";
import {
  BucketBudgetExhaustedError,
  configureRateLimit,
  __resetRateLimitCacheForTesting,
  type RateLimitDeps,
} from "@bounded-systems/github-budget";

beforeEach(() => {
  configureRateLimit({});
  __resetRateLimitCacheForTesting();
});
afterEach(() => {
  configureRateLimit({});
  __resetRateLimitCacheForTesting();
});

type Spawn = GhIssueEditSpawn; // edit/create/close spawn types are identical
type ExecResult = { exitCode: number; stdout: string; stderr: string; budgetError?: BucketBudgetExhaustedError };

const spawnReturning = (r: { status?: number | null; stdout?: string; stderr?: string }): Spawn =>
  (() => ({ status: 0, stdout: "", stderr: "", ...r })) as Spawn;

const rateLimitBody = (remaining: number) =>
  JSON.stringify({
    resources: {
      core: { limit: 5000, remaining, reset: 4_000_000_000 },
      graphql: { limit: 5000, remaining, reset: 4_000_000_000 },
      search: { limit: 30, remaining, reset: 4_000_000_000 },
    },
  });

const budgetWith = (remaining: number): RateLimitDeps => ({
  rawRunner: () => ({ stdout: rateLimitBody(remaining), stderr: "", status: 0 }),
  threshold: () => 100,
  appendAuditLine: () => {},
  ensureDir: () => {},
  homeDir: () => "/tmp",
  auditPath: () => null,
  runtimeContext: () => ({ verb: null, actor: "test", ghTruthReason: null }),
  measureCost: () => false,
});

const throwingBudget: RateLimitDeps = {
  rawRunner: () => {
    throw new Error("rate_limit probe blew up");
  },
  threshold: () => 100,
  appendAuditLine: () => {},
  ensureDir: () => {},
  homeDir: () => "/tmp",
  auditPath: () => null,
};

// One row per tool: how to invoke it (injected spawn), how to invoke it for
// real (no spawn), and its formatter.
const tools = [
  {
    name: "edit",
    run: (env: Record<string, string | undefined>, spawn?: Spawn) =>
      (spawn
        ? execGhIssueEdit({ number: 1, title: "t" }, env, spawn)
        : execGhIssueEdit({ number: 1, title: "t", repo: "prx-nonexistent-xyz/nope" }, env)) as ExecResult,
    format: formatGhIssueEditResult as (r: ExecResult, f: "plain" | "json") => string,
  },
  {
    name: "create",
    run: (env: Record<string, string | undefined>, spawn?: Spawn) =>
      (spawn
        ? execGhIssueCreate({ title: "t" }, env, spawn as never)
        : execGhIssueCreate({ title: "t", repo: "prx-nonexistent-xyz/nope" }, env)) as ExecResult,
    format: formatGhIssueCreateResult as (r: ExecResult, f: "plain" | "json") => string,
  },
  {
    name: "close",
    run: (env: Record<string, string | undefined>, spawn?: Spawn) =>
      (spawn
        ? execGhIssueClose({ number: 1 }, env, spawn as never)
        : execGhIssueClose({ number: 1, repo: "prx-nonexistent-xyz/nope" }, env)) as ExecResult,
    format: formatGhIssueCloseResult as (r: ExecResult, f: "plain" | "json") => string,
  },
] as const;

for (const tool of tools) {
  describe(`execGhIssue${tool.name} rate-limit boundary`, () => {
    test("pre-spawn gate exhaustion returns a budgetError without spawning", () => {
      configureRateLimit(budgetWith(0));
      let spawned = false;
      const spy: Spawn = (() => {
        spawned = true;
        return { status: 0, stdout: "", stderr: "" };
      }) as Spawn;
      const r = tool.run({}, spy);
      expect(r.budgetError).toBeInstanceOf(BucketBudgetExhaustedError);
      expect(spawned).toBe(false);
    });

    test("post-call recorder exhaustion returns a budgetError", () => {
      configureRateLimit(budgetWith(5000));
      const r = tool.run({}, spawnReturning({ status: 1, stderr: "API rate limit exceeded" }));
      expect(r.budgetError).toBeInstanceOf(BucketBudgetExhaustedError);
    });

    test("a non-budget error from the gate is rethrown", () => {
      configureRateLimit(throwingBudget);
      expect(() => tool.run({}, spawnReturning({}))).toThrow(/rate_limit probe blew up/);
    });

    test("a non-budget error from the post-call recorder is rethrown", () => {
      // Gate passes (call 1 healthy); the rate-limit stderr trips the recorder,
      // whose refresh (call 2) throws a generic error that must propagate.
      let calls = 0;
      configureRateLimit({
        rawRunner: () => {
          calls += 1;
          if (calls === 1) return { stdout: rateLimitBody(5000), stderr: "", status: 0 };
          throw new Error("post-call refresh blew up");
        },
        threshold: () => 100,
        appendAuditLine: () => {},
        ensureDir: () => {},
        homeDir: () => "/tmp",
        auditPath: () => null,
        runtimeContext: () => ({ verb: null, actor: "test", ghTruthReason: null }),
        measureCost: () => false,
      });
      expect(() =>
        tool.run({}, spawnReturning({ status: 1, stderr: "API rate limit exceeded" })),
      ).toThrow(/post-call refresh blew up/);
    });

    test("clean spawn passes through (gate unconfigured)", () => {
      const r = tool.run({}, spawnReturning({ status: 0, stdout: "ok" }));
      expect(r.exitCode).toBe(0);
      expect(r.budgetError).toBeUndefined();
    });

    test("default spawn wrapper runs the real gh boundary (offline-safe)", () => {
      const r = tool.run({});
      expect(typeof r.exitCode).toBe("number");
      expect(typeof r.stdout).toBe("string");
    });

    test("formatter renders json and a plain failure fallback", () => {
      const failed: ExecResult = { exitCode: 1, stdout: "", stderr: "boom" };
      expect(JSON.parse(tool.format(failed, "json")).exitCode).toBe(1);
      expect(tool.format(failed, "plain")).toBe("boom");
    });
  });
}
