// gh_pr_view — the narrow `gh pr view --json` wrapper used by postmerge.
// parseGhPrViewJson is pure; execGhPrView's spawn is injectable and its
// rate-limit gate/record branches are driven via the github-budget global
// config seam (reset between tests). The default spawn wrapper is exercised
// once through a real (offline-safe) gh invocation.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  buildGhPrViewArgs,
  execGhPrView,
  parseGhPrViewJson,
  type GhPrViewSpawn,
  type GhPrViewSpawnResult,
} from "../../src/tools/gh_pr_view.ts";
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

const spawnReturning = (r: Partial<GhPrViewSpawnResult>): GhPrViewSpawn =>
  () => ({ status: 0, stdout: "", stderr: "", ...r });

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

// ── buildGhPrViewArgs ─────────────────────────────────────────────────────────

describe("buildGhPrViewArgs", () => {
  test("builds the json field projection without a repo", () => {
    const args = buildGhPrViewArgs({ number: 42 });
    expect(args.slice(0, 4)).toEqual(["pr", "view", "42", "--json"]);
    expect(args).not.toContain("--repo");
  });
  test("appends --repo when supplied", () => {
    const args = buildGhPrViewArgs({ number: 1, repo: "o/n" });
    expect(args).toContain("--repo");
    expect(args[args.indexOf("--repo") + 1]).toBe("o/n");
  });
});

// ── parseGhPrViewJson ─────────────────────────────────────────────────────────

describe("parseGhPrViewJson", () => {
  const full = {
    body: "b",
    title: "t",
    number: 7,
    state: "MERGED",
    mergedAt: "2026-06-06T00:00:00Z",
    mergeCommit: { oid: "deadbeef" },
    closingIssuesReferences: [{ number: 1 }, { number: 2 }, { bogus: true }],
  };

  test("parses a full, well-formed payload", () => {
    const r = parseGhPrViewJson(JSON.stringify(full))!;
    expect(r.number).toBe(7);
    expect(r.state).toBe("MERGED");
    expect(r.mergeCommit).toEqual({ oid: "deadbeef" });
    // The non-number ref is filtered out.
    expect(r.closingIssuesReferences).toEqual([{ number: 1 }, { number: 2 }]);
  });

  test("returns null on unparseable JSON", () => {
    expect(parseGhPrViewJson("not json")).toBeNull();
  });
  test("returns null on a non-object", () => {
    expect(parseGhPrViewJson("42")).toBeNull();
  });
  test("returns null when number is missing", () => {
    expect(parseGhPrViewJson(JSON.stringify({ ...full, number: "x" }))).toBeNull();
  });
  test("returns null on an out-of-vocabulary state", () => {
    expect(parseGhPrViewJson(JSON.stringify({ ...full, state: "DRAFT" }))).toBeNull();
  });
  test("tolerates null mergedAt / absent mergeCommit / missing arrays", () => {
    const r = parseGhPrViewJson(
      JSON.stringify({ number: 3, state: "OPEN", mergedAt: null }),
    )!;
    expect(r.mergedAt).toBeNull();
    expect(r.mergeCommit).toBeNull();
    expect(r.closingIssuesReferences).toEqual([]);
    expect(r.body).toBe("");
  });
});

// ── execGhPrView ──────────────────────────────────────────────────────────────

describe("execGhPrView", () => {
  test("passes spawn stdout/stderr/status through (gate unconfigured)", () => {
    const r = execGhPrView({ number: 1 }, {}, spawnReturning({ status: 0, stdout: '{"ok":1}' }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('{"ok":1}');
    expect(r.budgetError).toBeUndefined();
  });

  test("coerces Buffer stdout and maps null status to exit 1", () => {
    const r = execGhPrView({ number: 1, cwd: "/tmp" }, {}, spawnReturning({
      status: null,
      stdout: Buffer.from("body"),
      stderr: Buffer.from("warn"),
    }));
    expect(r.stdout).toBe("body");
    expect(r.stderr).toBe("warn");
    expect(r.exitCode).toBe(1);
  });

  test("pre-spawn gate exhaustion returns a budgetError", () => {
    configureRateLimit(budgetWith(0));
    let spawned = false;
    const r = execGhPrView({ number: 1 }, {}, () => {
      spawned = true;
      return { status: 0, stdout: "", stderr: "" };
    });
    expect(r.budgetError).toBeInstanceOf(BucketBudgetExhaustedError);
    expect(spawned).toBe(false);
  });

  test("post-call recorder exhaustion returns a budgetError", () => {
    configureRateLimit(budgetWith(5000));
    const r = execGhPrView({ number: 1 }, {}, spawnReturning({
      status: 1,
      stderr: "API rate limit exceeded",
    }));
    expect(r.budgetError).toBeInstanceOf(BucketBudgetExhaustedError);
  });

  test("a non-budget error from the gate is rethrown", () => {
    // A throwing rate_limit refresh makes gateGhArgv throw a generic error,
    // which must propagate rather than be caught as a budget result.
    configureRateLimit({
      rawRunner: () => {
        throw new Error("rate_limit probe blew up");
      },
      threshold: () => 100,
      appendAuditLine: () => {},
      ensureDir: () => {},
      homeDir: () => "/tmp",
      auditPath: () => null,
    });
    expect(() => execGhPrView({ number: 1 }, {}, spawnReturning({}))).toThrow(
      /rate_limit probe blew up/,
    );
  });

  test("default spawn wrapper runs the real gh boundary (offline-safe)", () => {
    // No injected spawn → exercises defaultGhPrViewSpawn. gh is unauthenticated
    // / offline here, so it returns a non-zero result rather than data; we only
    // assert it returns a well-formed result without throwing.
    const r = execGhPrView({ number: 999_999_999, repo: "prx-nonexistent-xyz/nope" }, {});
    expect(typeof r.exitCode).toBe("number");
    expect(typeof r.stdout).toBe("string");
  });
});
