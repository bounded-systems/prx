// execGh rate-limit authority boundary (GH-1141). The two BucketBudgetExhausted
// branches — the pre-spawn gate and the post-call recorder — are driven through
// execGh's injectable seams (deps.budget / deps.spawn) so no live gh spawn or
// real GitHub budget state is needed. deps.budget is per-call, so the module's
// configured budget is never mutated; the shared snapshot cache is reset between
// tests for hygiene.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { execGh, type GhExecOptions } from "@bounded-systems/gh";
import {
  BucketBudgetExhaustedError,
  __resetRateLimitCacheForTesting,
  type RateLimitDeps,
} from "@bounded-systems/github-budget";

beforeEach(() => __resetRateLimitCacheForTesting());
afterEach(() => __resetRateLimitCacheForTesting());

const rateLimitBody = (remaining: number) =>
  JSON.stringify({
    resources: {
      core: { limit: 5000, remaining, reset: 4_000_000_000 },
      graphql: { limit: 5000, remaining, reset: 4_000_000_000 },
      search: { limit: 30, remaining, reset: 4_000_000_000 },
    },
  });

// A budget seam whose rate_limit refresh reports `remaining` for every bucket,
// with all FS/attribution side effects neutralized.
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

const listOpts: GhExecOptions = {
  group: "pr",
  subcommand: "list",
  args: [],
  state: "validating",
  role: "executor",
};

describe("execGh rate-limit gate", () => {
  test("pre-spawn gate: an exhausted bucket refuses before spawning gh", () => {
    let spawned = false;
    const r = execGh(
      listOpts,
      {},
      {
        budget: budgetWith(0), // 0 < threshold 100 → gate throws
        spawn: () => {
          spawned = true;
          return { status: 0, stdout: "", stderr: "", signal: null };
        },
      },
    );
    expect(r.budgetError).toBeInstanceOf(BucketBudgetExhaustedError);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/budget exhausted/);
    // The whole point of the gate is to NOT spend the spawn.
    expect(spawned).toBe(false);
  });

  test("post-call recorder: a rate-limit error on the gh result throws", () => {
    const r = execGh(
      listOpts,
      {},
      {
        budget: budgetWith(5000), // healthy → gate passes
        // The spawn returns GitHub's throttling stderr, which the recorder detects.
        spawn: () => ({ status: 1, stdout: "", stderr: "API rate limit exceeded", signal: null }),
      },
    );
    expect(r.budgetError).toBeInstanceOf(BucketBudgetExhaustedError);
    // Exit code + stderr from the underlying (failed) gh call are preserved.
    expect(r.exitCode).toBe(1);
  });

  test("a non-budget error from the gate is rethrown, not swallowed", () => {
    // The gate's catch only converts BucketBudgetExhaustedError into a result;
    // any other failure (here a throwing rate_limit refresh) propagates.
    expect(() =>
      execGh(
        listOpts,
        {},
        {
          budget: {
            rawRunner: () => {
              throw new Error("rate_limit probe blew up");
            },
            threshold: () => 100,
            appendAuditLine: () => {},
            ensureDir: () => {},
            homeDir: () => "/tmp",
            auditPath: () => null,
          },
        },
      ),
    ).toThrow(/rate_limit probe blew up/);
  });

  test("a non-budget error from the post-call recorder is rethrown", () => {
    // Gate passes (call 1 healthy); the gh result trips the throttle detector,
    // so the recorder refreshes the budget (call 2) — which here throws a
    // generic error that must propagate, not be swallowed as a budget result.
    let calls = 0;
    const budget: RateLimitDeps = {
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
    };
    expect(() =>
      execGh(
        listOpts,
        {},
        {
          budget,
          spawn: () => ({ status: 1, stdout: "", stderr: "API rate limit exceeded", signal: null }),
        },
      ),
    ).toThrow(/post-call refresh blew up/);
  });

  test("a signal-killed gh (null status) maps to exit 1", () => {
    const r = execGh(
      listOpts,
      {},
      {
        budget: budgetWith(5000),
        // A signal kill leaves status null; isCaptureFailure routes it to the
        // failure arm, where `?? 1` is the exact exit code.
        spawn: () => ({ status: null, stdout: "", stderr: "", signal: "SIGTERM" }),
      },
    );
    expect(r.budgetError).toBeUndefined();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/killed by SIGTERM/);
  });

  test("healthy budget + clean spawn passes through unchanged", () => {
    const r = execGh(
      listOpts,
      {},
      {
        budget: budgetWith(5000),
        spawn: () => ({ status: 0, stdout: "#1 a pr\n", stderr: "", signal: null }),
      },
    );
    expect(r.budgetError).toBeUndefined();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("#1 a pr\n");
  });
});
