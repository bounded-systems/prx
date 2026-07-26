// `runBeadsSync` no-op coverage (GH-1012). The beads/dolt store was removed, so
// the bd↔external-domain reconcile has nothing to operate on: `runBeadsSync` is
// retained as a typed no-op that reports a zero reconcile and exits 0. The
// former tick-loop tests (pull/push/close-apply, budget gating, limit slicing,
// adapter.bulkClose dispatch) covered bd behavior that no longer exists and were
// removed. The pure budget helpers still used by `src/sync/backfill.ts`
// (`resolveThreshold`, `graphqlRemaining`, `DEFAULT_BUDGET_THRESHOLD`) keep
// dedicated coverage here.

import { describe, expect, test } from "bun:test";

import {
  runBeadsSync,
  resolveThreshold,
  graphqlRemaining,
  DEFAULT_BUDGET_THRESHOLD,
  type RunBeadsSyncOptions,
} from "../../src/sync/run.ts";

function opts(over: Partial<RunBeadsSyncOptions> = {}): RunBeadsSyncOptions {
  return { domain: "gh", dryRun: false, limit: 0, format: "plain", ...over };
}

const sink = { log: () => {}, error: () => {} };

// ── tests ──────────────────────────────────────────────────────────────────

describe("runBeadsSync — no-op reconcile (GH-1012)", () => {
  test("reports a zero summary and exits 0", async () => {
    const result = await runBeadsSync(opts({ repo: "bdelanghe/ai-home" }), sink);
    expect(result.exitCode).toBe(0);
    expect(result.pairs).toEqual([]);
    expect(result.summary).toMatchObject({
      repo: "bdelanghe/ai-home",
      domain: "gh",
      scanned: 0,
      pinned: 0,
      pulled: 0,
      pushed: 0,
      closedByPull: 0,
      failed: 0,
      deferred: 0,
      budgetPaused: false,
      dryRun: false,
    });
  });

  test("threads the requested domain + dryRun through the zero summary", async () => {
    const result = await runBeadsSync(opts({ domain: "notion", dryRun: true }), sink);
    expect(result.exitCode).toBe(0);
    expect(result.summary.domain).toBe("notion");
    expect(result.summary.dryRun).toBe(true);
  });

  test("does no I/O — never logs or errors, and accepts an omitted deps arg", async () => {
    const logs: string[] = [];
    const errs: string[] = [];
    const result = await runBeadsSync(opts(), {
      log: (l) => logs.push(l),
      error: (l) => errs.push(l),
    });
    expect(result.exitCode).toBe(0);
    expect(logs).toEqual([]);
    expect(errs).toEqual([]);
  });
});

describe("budget helpers (reused by backfill)", () => {
  test("resolveThreshold prefers a finite non-negative option", () => {
    expect(resolveThreshold(42)).toBe(42);
    expect(resolveThreshold(0)).toBe(0);
  });

  test("resolveThreshold falls back to the default when unset/invalid", () => {
    expect(resolveThreshold(undefined)).toBe(DEFAULT_BUDGET_THRESHOLD);
    expect(resolveThreshold(-1)).toBe(DEFAULT_BUDGET_THRESHOLD);
  });

  test("graphqlRemaining extracts the graphql bucket's remaining, else null", () => {
    expect(
      graphqlRemaining([
        { bucket: "graphql", limit: 5000, remaining: 4000, resetAt: 0, fetchedAt: 0 },
      ]),
    ).toBe(4000);
    expect(graphqlRemaining(null)).toBeNull();
    expect(
      graphqlRemaining([{ bucket: "core", limit: 5000, remaining: 10, resetAt: 0, fetchedAt: 0 }]),
    ).toBeNull();
  });
});
