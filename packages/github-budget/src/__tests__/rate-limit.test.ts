import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetRateLimitCacheForTesting,
  beginSweep,
  classifyBucket,
  configureRateLimit,
  endSweep,
  estimateSweepCost,
  getSweepCost,
  GraphQLBudgetExhaustedError,
  RestBudgetExhaustedError,
  SearchBudgetExhaustedError,
  BucketBudgetExhaustedError,
  gateGhArgv,
  ghOperationName,
  parseRateLimitBlock,
  readRateLimitAuditRows,
  recordGhResult,
  refreshBudget,
  withBucketGate,
  isRateLimitProbe,
  type RateLimitDeps,
  type RateLimitAuditEntry,
} from "@bounded-systems/github-budget";
import { __resetAuditRuntimeContextForTesting } from "@bounded-systems/audit-context";
import type { CommandResult } from "@bounded-systems/proc";

type RateLimitResources = {
  core: { limit: number; remaining: number; reset: number };
  graphql: { limit: number; remaining: number; reset: number };
  search: { limit: number; remaining: number; reset: number };
};

function rateLimitStdout(resources: RateLimitResources): string {
  return JSON.stringify({ resources });
}

function fixedNow(t: number): () => Date {
  return () => new Date(t);
}

function makeAuditCapture(): {
  rows: RateLimitAuditEntry[];
  appendAuditLine: (path: string, line: string) => void;
  ensureDir: (path: string) => void;
} {
  const rows: RateLimitAuditEntry[] = [];
  return {
    rows,
    appendAuditLine: (_path, line) => {
      rows.push(JSON.parse(line.trim()));
    },
    ensureDir: () => {},
  };
}

function makeRunner(
  resources: RateLimitResources,
  spies?: { calls?: string[][] },
): (cmd: string[]) => CommandResult {
  return (cmd) => {
    spies?.calls?.push(cmd);
    if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "rate_limit") {
      return { stdout: rateLimitStdout(resources), stderr: "", status: 0 };
    }
    return { stdout: "", stderr: "", status: 0 };
  };
}

// A runner that ignores argv and always returns the same result. The explicit
// return-type annotation keeps `withBucketGate`'s generic from collapsing `R`
// to a 0-arg signature (which would reject `wrapped(["gh", …])`).
function constRunner(result: CommandResult): (cmd: string[]) => CommandResult {
  return () => result;
}

const HEALTHY_RESOURCES: RateLimitResources = {
  core: { limit: 5000, remaining: 4900, reset: 9999 },
  graphql: { limit: 5000, remaining: 4900, reset: 9999 },
  search: { limit: 30, remaining: 30, reset: 9999 },
};

beforeEach(() => {
  __resetRateLimitCacheForTesting();
  configureRateLimit({});
  // The audit runtime context is process-global; clear any verb stamped by a
  // prior `runCli` in another test file so the "ambient default" case is honest.
  __resetAuditRuntimeContextForTesting();
});

describe("classifyBucket", () => {
  // Coverage matrix mirroring representative argv shapes from github.ts call
  // sites. Each row pins one expected bucket so future drift is loud.
  const cases: Array<{ argv: string[]; bucket: "core" | "graphql" | "search"; note: string }> = [
    // graphql via `--json` flag
    { argv: ["gh", "pr", "view", "--json", "number", "--jq", ".number"], bucket: "graphql", note: "pr view --json" },
    { argv: ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], bucket: "graphql", note: "repo view --json" },
    {
      argv: ["gh", "issue", "list", "--state", "open", "--limit", "50", "--json", "number,title,url,labels", "-R", "o/r"],
      bucket: "graphql",
      note: "issue list --json",
    },
    {
      argv: ["gh", "issue", "list", "--state", "all", "--limit", "500", "--json", "number,title,url,state", "-R", "o/r"],
      bucket: "graphql",
      note: "issue list --state all",
    },
    {
      argv: ["gh", "issue", "view", "42", "--json", "number,title,state,body,url,labels", "-R", "o/r"],
      bucket: "graphql",
      note: "issue view --json",
    },
    {
      argv: ["gh", "issue", "view", "42", "--json", "number,state", "-R", "o/r"],
      bucket: "graphql",
      note: "issue view --json (narrow)",
    },
    {
      argv: ["gh", "pr", "checks", "123", "--json", "name,state,link,description"],
      bucket: "graphql",
      note: "pr checks --json",
    },

    // graphql via `api graphql`
    { argv: ["gh", "api", "graphql"], bucket: "graphql", note: "api graphql bare" },
    { argv: ["gh", "api", "graphql", "-f", "query=..."], bucket: "graphql", note: "api graphql with query" },

    // core via `api`
    { argv: ["gh", "api", "user", "--jq", ".login"], bucket: "core", note: "api user" },
    { argv: ["gh", "api", "repos/owner/repo", "--jq", ".owner.type"], bucket: "core", note: "api repos/{repo}" },
    { argv: ["gh", "api", "repos/o/r/branches/main/protection"], bucket: "core", note: "api branch protection" },
    { argv: ["gh", "api", "repos/o/r/branches/main", "--jq", ".commit.sha"], bucket: "core", note: "api branch sha" },
    { argv: ["gh", "api", "repos/o/r/commits/abc/check-runs", "--jq", ".check_runs[].name"], bucket: "core", note: "api check-runs" },
    { argv: ["gh", "api", "rate_limit"], bucket: "core", note: "api rate_limit (probe)" },

    // search subcommand
    { argv: ["gh", "search", "issues", "is:open"], bucket: "search", note: "search issues" },
    { argv: ["gh", "search", "prs", "is:open"], bucket: "search", note: "search prs" },

    // plain commands (no --json) → core
    { argv: ["gh", "pr", "view"], bucket: "core", note: "pr view (no --json)" },
    { argv: ["gh", "pr", "ready", "123"], bucket: "core", note: "pr ready" },
    { argv: ["gh", "pr", "ready", "123", "--undo"], bucket: "core", note: "pr ready --undo" },
    { argv: ["gh", "pr", "ready", "123", "--undo", "-R", "o/r"], bucket: "core", note: "pr ready --undo -R" },
    { argv: ["gh", "pr", "edit", "123", "--title", "x", "--body-file", "/tmp/b"], bucket: "core", note: "pr edit" },
    { argv: ["gh", "pr", "diff", "123", "--name-only", "-R", "o/r"], bucket: "core", note: "pr diff --name-only" },
    { argv: ["gh", "pr", "diff", "123", "--color", "never", "-R", "o/r"], bucket: "core", note: "pr diff --color" },
    { argv: ["gh", "run", "view", "abc", "--log-failed"], bucket: "core", note: "run view --log-failed" },

    // edge cases
    { argv: ["gh"], bucket: "core", note: "bare gh" },
    { argv: [], bucket: "core", note: "empty" },
  ];

  for (const c of cases) {
    test(`${c.note} → ${c.bucket}`, () => {
      expect(classifyBucket(c.argv)).toBe(c.bucket);
    });
  }

  test("strips leading 'gh' before classification", () => {
    expect(classifyBucket(["gh", "search", "issues"])).toBe("search");
    expect(classifyBucket(["search", "issues"])).toBe("search");
  });
});

describe("isRateLimitProbe", () => {
  test("matches gh api rate_limit", () => {
    expect(isRateLimitProbe(["gh", "api", "rate_limit"])).toBe(true);
    expect(isRateLimitProbe(["api", "rate_limit"])).toBe(true);
  });
  test("rejects everything else", () => {
    expect(isRateLimitProbe(["gh", "api", "user"])).toBe(false);
    expect(isRateLimitProbe(["gh", "pr", "view", "--json", "number"])).toBe(false);
    expect(isRateLimitProbe(["gh"])).toBe(false);
    expect(isRateLimitProbe([])).toBe(false);
  });
});

describe("gateGhArgv", () => {
  test("at graphql.remaining=0 throws GraphQLBudgetExhaustedError without spawning", () => {
    const calls: string[][] = [];
    const audit = makeAuditCapture();
    const deps: RateLimitDeps = {
      rawRunner: makeRunner(
        {
          core: { limit: 5000, remaining: 4900, reset: 9999 },
          graphql: { limit: 5000, remaining: 0, reset: 9999 },
          search: { limit: 30, remaining: 30, reset: 9999 },
        },
        { calls },
      ),
      now: fixedNow(1_000_000),
      auditPath: () => "/tmp/audit.jsonl",
      ...audit,
    };

    expect(() =>
      gateGhArgv(["gh", "pr", "view", "--json", "number"], deps),
    ).toThrow(GraphQLBudgetExhaustedError);

    // Only the rate_limit refresh should have been called — never the gh call.
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(["gh", "api", "rate_limit"]);

    expect(audit.rows).toHaveLength(1);
    const row = audit.rows[0]!;
    expect(row.bucket).toBe("graphql");
    expect(row.remaining_before).toBe(0);
    expect(row.remaining_after).toBeNull();
    expect(row.exit_code).toBe(-1);
    expect(row.threw).toBe("BUDGET_EXHAUSTED");
  });

  test("REST-classified call passes when graphql=0 but core=4900", () => {
    const calls: string[][] = [];
    const audit = makeAuditCapture();
    const deps: RateLimitDeps = {
      rawRunner: makeRunner(
        {
          core: { limit: 5000, remaining: 4900, reset: 9999 },
          graphql: { limit: 5000, remaining: 0, reset: 9999 },
          search: { limit: 30, remaining: 30, reset: 9999 },
        },
        { calls },
      ),
      now: fixedNow(1_000_000),
      auditPath: () => "/tmp/audit.jsonl",
      ...audit,
    };

    const gate = gateGhArgv(["gh", "api", "user"], deps);
    expect(gate).not.toBeNull();
    expect(gate!.bucket).toBe("core");
    expect(gate!.remainingBefore).toBe(4900);
    // Only the rate_limit refresh — gate doesn't spawn the actual gh call.
    expect(calls).toEqual([["gh", "api", "rate_limit"]]);
    // No audit written for the pre-call gate when allowed.
    expect(audit.rows).toHaveLength(0);
  });

  test("rate_limit probe is skipped (no gate, no audit)", () => {
    const calls: string[][] = [];
    const audit = makeAuditCapture();
    const deps: RateLimitDeps = {
      rawRunner: makeRunner(
        {
          core: { limit: 5000, remaining: 0, reset: 9999 },
          graphql: { limit: 5000, remaining: 0, reset: 9999 },
          search: { limit: 30, remaining: 0, reset: 9999 },
        },
        { calls },
      ),
      now: fixedNow(1_000_000),
      auditPath: () => "/tmp/audit.jsonl",
      ...audit,
    };

    const gate = gateGhArgv(["gh", "api", "rate_limit"], deps);
    expect(gate).toBeNull();
    expect(calls).toEqual([]);
    expect(audit.rows).toEqual([]);
  });

  test("custom threshold gates above remaining", () => {
    const audit = makeAuditCapture();
    const deps: RateLimitDeps = {
      rawRunner: makeRunner({
        core: { limit: 5000, remaining: 99, reset: 9999 },
        graphql: { limit: 5000, remaining: 99, reset: 9999 },
        search: { limit: 30, remaining: 30, reset: 9999 },
      }),
      now: fixedNow(1_000_000),
      threshold: () => 100,
      auditPath: () => "/tmp/audit.jsonl",
      ...audit,
    };
    expect(() => gateGhArgv(["gh", "api", "user"], deps)).toThrow(RestBudgetExhaustedError);
    expect(() => gateGhArgv(["gh", "pr", "view", "--json", "x"], deps)).toThrow(GraphQLBudgetExhaustedError);
  });

  test("search bucket throws SearchBudgetExhaustedError", () => {
    const audit = makeAuditCapture();
    const deps: RateLimitDeps = {
      rawRunner: makeRunner({
        core: { limit: 5000, remaining: 5000, reset: 9999 },
        graphql: { limit: 5000, remaining: 5000, reset: 9999 },
        search: { limit: 30, remaining: 0, reset: 9999 },
      }),
      now: fixedNow(1_000_000),
      auditPath: () => "/tmp/audit.jsonl",
      ...audit,
    };
    expect(() => gateGhArgv(["gh", "search", "issues", "is:open"], deps)).toThrow(SearchBudgetExhaustedError);
  });
});

describe("recordGhResult", () => {
  test("writes one audit row per allowed call", () => {
    const audit = makeAuditCapture();
    const deps: RateLimitDeps = {
      rawRunner: makeRunner({
        core: { limit: 5000, remaining: 4900, reset: 9999 },
        graphql: { limit: 5000, remaining: 4900, reset: 9999 },
        search: { limit: 30, remaining: 30, reset: 9999 },
      }),
      now: fixedNow(1_000_000),
      auditPath: () => "/tmp/audit.jsonl",
      ...audit,
    };
    const gate = gateGhArgv(["gh", "api", "user"], deps);
    expect(gate).not.toBeNull();
    recordGhResult(
      ["gh", "api", "user"],
      gate!.bucket,
      gate!.remainingBefore,
      { stdout: "alice", stderr: "", status: 0 },
      deps,
    );
    expect(audit.rows).toHaveLength(1);
    const row = audit.rows[0]!;
    expect(row.bucket).toBe("core");
    expect(row.remaining_before).toBe(4900);
    expect(row.remaining_after).toBe(4900);
    expect(row.exit_code).toBe(0);
    expect(row.threw).toBeNull();
  });

  test("detects 'API rate limit exceeded' stderr and throws typed error", () => {
    const audit = makeAuditCapture();
    let resources: RateLimitResources = {
      core: { limit: 5000, remaining: 4900, reset: 9999 },
      graphql: { limit: 5000, remaining: 4900, reset: 9999 },
      search: { limit: 30, remaining: 30, reset: 9999 },
    };
    const runner = (cmd: string[]): CommandResult => {
      if (cmd[1] === "api" && cmd[2] === "rate_limit") {
        return { stdout: rateLimitStdout(resources), stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 0 };
    };
    const deps: RateLimitDeps = {
      rawRunner: runner,
      now: fixedNow(1_000_000),
      auditPath: () => "/tmp/audit.jsonl",
      ...audit,
    };
    const gate = gateGhArgv(["gh", "issue", "list", "--json", "number"], deps);
    expect(gate).not.toBeNull();
    // Simulate gh hitting the wall between snapshot and call
    resources = {
      core: { limit: 5000, remaining: 4900, reset: 9999 },
      graphql: { limit: 5000, remaining: 0, reset: 9999 },
      search: { limit: 30, remaining: 30, reset: 9999 },
    };
    expect(() =>
      recordGhResult(
        ["gh", "issue", "list", "--json", "number"],
        gate!.bucket,
        gate!.remainingBefore,
        { stdout: "", stderr: "GraphQL: API rate limit exceeded for user ID 1", status: 1 },
        deps,
      ),
    ).toThrow(GraphQLBudgetExhaustedError);
    expect(audit.rows).toHaveLength(1);
    const row = audit.rows[0]!;
    expect(row.threw).toBe("BUDGET_EXHAUSTED");
    expect(row.bucket).toBe("graphql");
    expect(row.remaining_after).toBe(0);
  });

  test("plain non-zero exit records RUNTIME_ERROR (no throw)", () => {
    const audit = makeAuditCapture();
    const deps: RateLimitDeps = {
      rawRunner: makeRunner({
        core: { limit: 5000, remaining: 4900, reset: 9999 },
        graphql: { limit: 5000, remaining: 4900, reset: 9999 },
        search: { limit: 30, remaining: 30, reset: 9999 },
      }),
      now: fixedNow(1_000_000),
      auditPath: () => "/tmp/audit.jsonl",
      ...audit,
    };
    const gate = gateGhArgv(["gh", "api", "user"], deps);
    expect(gate).not.toBeNull();
    expect(() =>
      recordGhResult(
        ["gh", "api", "user"],
        gate!.bucket,
        gate!.remainingBefore,
        { stdout: "", stderr: "auth failed", status: 1 },
        deps,
      ),
    ).not.toThrow();
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.threw).toBe("RUNTIME_ERROR");
    expect(audit.rows[0]!.exit_code).toBe(1);
  });
});

describe("withBucketGate decorator", () => {
  test("non-gh commands pass through untouched", () => {
    const calls: string[][] = [];
    const inner = (cmd: string[]): CommandResult => {
      calls.push(cmd);
      return { stdout: "ok", stderr: "", status: 0 };
    };
    const audit = makeAuditCapture();
    const wrapped = withBucketGate(inner, {
      rawRunner: () => ({ stdout: "{}", stderr: "", status: 0 }),
      auditPath: () => "/tmp/audit.jsonl",
      ...audit,
    });
    const result = wrapped(["git", "status"]);
    expect(result.status).toBe(0);
    expect(calls).toEqual([["git", "status"]]);
    expect(audit.rows).toEqual([]);
  });

  test("gh call passes through when budget healthy and writes an attributed audit row", () => {
    const calls: string[][] = [];
    const inner = (cmd: string[]): CommandResult => {
      calls.push(cmd);
      return { stdout: "out", stderr: "", status: 0 };
    };
    const audit = makeAuditCapture();
    const deps: RateLimitDeps = {
      rawRunner: makeRunner(HEALTHY_RESOURCES),
      now: fixedNow(1_000_000),
      auditPath: () => "/tmp/audit.jsonl",
      runtimeContext: () => ({ verb: "triage.status", actor: "claude-code", ghTruthReason: null }),
      measureCost: () => false,
      ...audit,
    };
    const wrapped = withBucketGate(inner, deps);
    const result = wrapped(["gh", "api", "user"]);
    expect(result.status).toBe(0);
    // inner runner sees the gh call (not the rate_limit refresh — that goes to rawRunner)
    expect(calls).toEqual([["gh", "api", "user"]]);
    expect(audit.rows).toHaveLength(1);
    // GH-1533: the one rate-limit.jsonl row now carries attribution fields.
    expect(audit.rows[0]).toMatchObject({
      bucket: "core",
      exit_code: 0,
      threw: null,
      api: "rest",
      verb: "triage.status",
      actor: "claude-code",
      operation: "user",
    });
    expect(typeof audit.rows[0]!.duration_ms).toBe("number");
    expect(audit.rows[0]!.ts).toBe(new Date(1_000_000).toISOString());
  });

  test("inner runner that throws on non-zero still records an attributed audit row + propagates", () => {
    const audit = makeAuditCapture();
    const failing = (_cmd: string[]): CommandResult => {
      const result: CommandResult = { stdout: "", stderr: "boom", status: 1 };
      const err = new Error("boom");
      Object.assign(err, { result });
      throw err;
    };
    const deps: RateLimitDeps = {
      rawRunner: makeRunner(HEALTHY_RESOURCES),
      now: fixedNow(1_000_000),
      auditPath: () => "/tmp/audit.jsonl",
      ...audit,
    };
    const wrapped = withBucketGate(failing, deps);
    expect(() => wrapped(["gh", "api", "user"])).toThrow("boom");
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ exit_code: 1, threw: "RUNTIME_ERROR", operation: "user" });
  });
});

describe("withBucketGate attribution fields on rate-limit.jsonl rows (GH-1533)", () => {
  test("classifies a --json call as graphql and extracts <noun>.<verb> operation", () => {
    const audit = makeAuditCapture();
    const wrapped = withBucketGate(
      constRunner({ stdout: "[]", stderr: "", status: 0 }),
      {
        rawRunner: makeRunner(HEALTHY_RESOURCES),
        now: fixedNow(2_000_000),
        auditPath: () => "/tmp/a.jsonl",
        runtimeContext: () => ({ verb: "intake.search", actor: "claude-code", ghTruthReason: null }),
        measureCost: () => false,
        ...audit,
      },
    );
    wrapped(["gh", "issue", "list", "--state", "open", "--json", "number", "-R", "o/r"]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      api: "graphql",
      bucket: "graphql",
      verb: "intake.search",
      operation: "issue.list",
      // no rateLimit block, measureCost off → cost null; remaining/limit from
      // the gate-time snapshot (HEALTHY_RESOURCES.graphql).
      cost: null,
      remaining: 4900,
      limit: 5000,
    });
  });

  test("populates cost/remaining/limit/reset_at from a rateLimit block in a graphql body", () => {
    const audit = makeAuditCapture();
    const body = JSON.stringify({
      data: { rateLimit: { cost: 3, remaining: 4997, limit: 5000, resetAt: "2026-05-12T17:00:00Z" } },
    });
    const wrapped = withBucketGate(
      constRunner({ stdout: body, stderr: "", status: 0 }),
      {
        rawRunner: makeRunner(HEALTHY_RESOURCES),
        now: fixedNow(3_000_000),
        auditPath: () => "/tmp/a.jsonl",
        runtimeContext: () => ({ verb: "doctor.inventory", actor: "claude-code", ghTruthReason: null }),
        ...audit,
      },
    );
    wrapped(["gh", "api", "graphql", "-f", "query=query Probe { rateLimit { cost remaining limit resetAt } }"]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      api: "graphql",
      operation: "Probe",
      cost: 3,
      remaining: 4997,
      limit: 5000,
      reset_at: "2026-05-12T17:00:00.000Z",
    });
  });

  test("measureCost() does a free post-call rate_limit refresh and derives cost from the delta", () => {
    const audit = makeAuditCapture();
    // Two rate_limit probes: gate refresh (4900) then post-call refresh (4898).
    let probe = 0;
    const rawRunner = (cmd: string[]): CommandResult => {
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "rate_limit") {
        probe += 1;
        const remaining = probe === 1 ? 4900 : 4898;
        return {
          stdout: JSON.stringify({
            resources: {
              core: { limit: 5000, remaining, reset: 9999 },
              graphql: { limit: 5000, remaining, reset: 9999 },
              search: { limit: 30, remaining: 30, reset: 9999 },
            },
          }),
          stderr: "",
          status: 0,
        };
      }
      return { stdout: "", stderr: "", status: 0 };
    };
    const wrapped = withBucketGate(
      constRunner({ stdout: "", stderr: "", status: 0 }),
      {
        rawRunner,
        now: fixedNow(4_000_000),
        auditPath: () => "/tmp/a.jsonl",
        measureCost: () => true,
        ...audit,
      },
    );
    wrapped(["gh", "api", "repos/o/r/branches/main", "--jq", ".commit.sha"]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      api: "rest",
      bucket: "core",
      cost: 2,
      cost_delta: 2,
      remaining: 4898,
      limit: 5000,
      operation: "repos/o/r/branches/main",
    });
  });

  test("pre-spawn gate exhaustion writes an attributed audit row (exit_code -1, threw BUDGET_EXHAUSTED) and re-throws", () => {
    const audit = makeAuditCapture();
    const calls: string[][] = [];
    const inner = (cmd: string[]): CommandResult => {
      calls.push(cmd);
      return { stdout: "", stderr: "", status: 0 };
    };
    const wrapped = withBucketGate(inner, {
      rawRunner: makeRunner({
        core: { limit: 5000, remaining: 5000, reset: 9999 },
        graphql: { limit: 5000, remaining: 0, reset: 1_700_000 },
        search: { limit: 30, remaining: 30, reset: 9999 },
      }),
      now: fixedNow(5_000_000),
      auditPath: () => "/tmp/a.jsonl",
      runtimeContext: () => ({ verb: "plan.preflight", actor: "claude-code", ghTruthReason: null }),
      ...audit,
    });
    expect(() => wrapped(["gh", "issue", "list", "--json", "number"])).toThrow(GraphQLBudgetExhaustedError);
    // Gated out before spawn — inner never ran.
    expect(calls).toEqual([]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      api: "graphql",
      bucket: "graphql",
      verb: "plan.preflight",
      operation: "issue.list",
      exit_code: -1,
      threw: "BUDGET_EXHAUSTED",
      duration_ms: 0,
      remaining: 0,
      limit: 5000,
    });
  });

  test("stderr-detected exhaustion writes one attributed row before re-throwing the typed error", () => {
    const audit = makeAuditCapture();
    const wrapped = withBucketGate(
      constRunner({ stdout: "", stderr: "API rate limit exceeded for user", status: 1 }),
      {
        rawRunner: makeRunner(HEALTHY_RESOURCES),
        now: fixedNow(6_000_000),
        auditPath: () => "/tmp/a.jsonl",
        runtimeContext: () => ({ verb: "intake.search", actor: "claude-code", ghTruthReason: null }),
        ...audit,
      },
    );
    expect(() => wrapped(["gh", "issue", "list", "--json", "number"])).toThrow(BucketBudgetExhaustedError);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ threw: "BUDGET_EXHAUSTED", exit_code: 1, verb: "intake.search" });
  });

  test("the gh api rate_limit probe itself never writes an audit row", () => {
    const audit = makeAuditCapture();
    const wrapped = withBucketGate(makeRunner(HEALTHY_RESOURCES), {
      rawRunner: makeRunner(HEALTHY_RESOURCES),
      now: fixedNow(7_000_000),
      auditPath: () => "/tmp/a.jsonl",
      ...audit,
    });
    wrapped(["gh", "api", "rate_limit"]);
    expect(audit.rows).toEqual([]);
  });

  test("verb is null when no runtimeContext override is wired (ambient default)", () => {
    const audit = makeAuditCapture();
    const wrapped = withBucketGate(
      constRunner({ stdout: "", stderr: "", status: 0 }),
      {
        rawRunner: makeRunner(HEALTHY_RESOURCES),
        now: fixedNow(8_000_000),
        auditPath: () => "/tmp/a.jsonl",
        ...audit,
      },
    );
    wrapped(["gh", "api", "user"]);
    expect(audit.rows).toHaveLength(1);
    // Default ambient context: verb null, actor "claude-code".
    expect(audit.rows[0]!.verb).toBeNull();
    expect(audit.rows[0]!.actor).toBe("claude-code");
  });
});

// GH-1602 — the residual gh calls in `runStatusActor` (drift / stale / forward-orphan
// comparators) tag themselves with a typed reason via `withGhTruthReason`. The
// gated runner stamps it onto the audit row so the audit log can distinguish
// a justified gh comparator from an accidental gh fallback.
describe("withBucketGate gh_truth_reason on rate-limit.jsonl rows (GH-1602)", () => {
  test("stamps the runtime gh_truth_reason onto the row", () => {
    const audit = makeAuditCapture();
    const wrapped = withBucketGate(
      constRunner({ stdout: "[]", stderr: "", status: 0 }),
      {
        rawRunner: makeRunner(HEALTHY_RESOURCES),
        now: fixedNow(9_000_000),
        auditPath: () => "/tmp/a.jsonl",
        runtimeContext: () => ({
          verb: "triage.status",
          actor: "claude-code",
          ghTruthReason: "drift-comparator",
        }),
        measureCost: () => false,
        ...audit,
      },
    );
    wrapped(["gh", "issue", "list", "--state", "open", "--json", "number", "-R", "o/r"]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.gh_truth_reason).toBe("drift-comparator");
  });

  test("a gated-out (budget-exhausted) row also carries the reason", () => {
    const audit = makeAuditCapture();
    const wrapped = withBucketGate(constRunner({ stdout: "", stderr: "", status: 0 }), {
      rawRunner: makeRunner({
        core: { limit: 5000, remaining: 5000, reset: 9999 },
        graphql: { limit: 5000, remaining: 0, reset: 1_700_000 },
        search: { limit: 30, remaining: 30, reset: 9999 },
      }),
      now: fixedNow(10_000_000),
      auditPath: () => "/tmp/a.jsonl",
      runtimeContext: () => ({
        verb: "triage.status",
        actor: "claude-code",
        ghTruthReason: "stale-comparator",
      }),
      ...audit,
    });
    expect(() => wrapped(["gh", "issue", "list", "--state", "closed", "--json", "number"])).toThrow(
      GraphQLBudgetExhaustedError,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.gh_truth_reason).toBe("stale-comparator");
    expect(audit.rows[0]!.threw).toBe("BUDGET_EXHAUSTED");
  });

  test("gh_truth_reason is null by default — the typical attribution case", () => {
    const audit = makeAuditCapture();
    const wrapped = withBucketGate(
      constRunner({ stdout: "", stderr: "", status: 0 }),
      {
        rawRunner: makeRunner(HEALTHY_RESOURCES),
        now: fixedNow(11_000_000),
        auditPath: () => "/tmp/a.jsonl",
        // Ambient context, no override — defaults to ghTruthReason: null.
        ...audit,
      },
    );
    wrapped(["gh", "api", "user"]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.gh_truth_reason).toBeNull();
  });
});

describe("ghOperationName", () => {
  const cases: Array<{ argv: string[]; expected: string | null; note: string }> = [
    { argv: ["gh", "pr", "view", "--json", "number"], expected: "pr.view", note: "noun.verb" },
    { argv: ["gh", "issue", "list", "-R", "o/r"], expected: "issue.list", note: "noun.verb with flags after" },
    { argv: ["gh", "auth", "status"], expected: "auth.status", note: "noun.verb no flags" },
    { argv: ["gh", "api", "repos/o/r/branches/main"], expected: "repos/o/r/branches/main", note: "rest path" },
    { argv: ["gh", "api", "rate_limit"], expected: "rate_limit", note: "rest path (probe)" },
    {
      argv: ["gh", "api", "graphql", "-f", "query=query GetPullRequest($n:Int!) { repository { pullRequest(number:$n) { id } } }"],
      expected: "GetPullRequest",
      note: "named graphql query",
    },
    {
      argv: ["gh", "api", "graphql", "-f", "query=mutation EnableAutomerge($id:ID!) { enablePullRequestAutoMerge(input:{pullRequestId:$id}) { clientMutationId } }"],
      expected: "EnableAutomerge",
      note: "named graphql mutation",
    },
    {
      argv: ["gh", "api", "graphql", "-f", "query=query($owner:String!,$repo:String!) { repository(owner:$owner,name:$repo) { id } }"],
      expected: null,
      note: "anonymous graphql query",
    },
    { argv: ["gh", "api", "graphql", "-F", "query=@query.graphql"], expected: null, note: "@file query — not read" },
    { argv: ["gh", "api", "graphql"], expected: null, note: "bare api graphql" },
    { argv: [], expected: null, note: "empty argv" },
    { argv: ["gh"], expected: null, note: "bare gh" },
  ];
  for (const { argv, expected, note } of cases) {
    test(`${note}: ${argv.join(" ") || "<empty>"} → ${expected ?? "null"}`, () => {
      expect(ghOperationName(argv)).toBe(expected);
    });
  }
});

describe("parseRateLimitBlock", () => {
  test("reads .data.rateLimit", () => {
    const block = parseRateLimitBlock(
      JSON.stringify({ data: { rateLimit: { cost: 1, remaining: 4999, limit: 5000, resetAt: "2026-05-12T18:00:00Z" } } }),
    );
    expect(block).toEqual({ cost: 1, remaining: 4999, limit: 5000, resetAtMs: Date.parse("2026-05-12T18:00:00Z") });
  });

  test("reads a top-level rateLimit", () => {
    const block = parseRateLimitBlock(JSON.stringify({ rateLimit: { cost: 2, remaining: 10, limit: 5000, resetAt: "bogus" } }));
    expect(block).toEqual({ cost: 2, remaining: 10, limit: 5000, resetAtMs: null });
  });

  test("returns null on non-JSON, empty, or absent block", () => {
    expect(parseRateLimitBlock("not json")).toBeNull();
    expect(parseRateLimitBlock("")).toBeNull();
    expect(parseRateLimitBlock(undefined)).toBeNull();
    expect(parseRateLimitBlock(JSON.stringify({ data: { repository: { id: "x" } } }))).toBeNull();
  });
});

describe("BucketBudgetExhaustedError shape", () => {
  test("typed errors expose bucket, remaining, resetAt, argv", () => {
    const snap = { bucket: "graphql" as const, limit: 5000, remaining: 0, resetAt: 1234567000, fetchedAt: 1234560000 };
    const err = new GraphQLBudgetExhaustedError(snap, ["gh", "issue", "list", "--json", "x"]);
    expect(err).toBeInstanceOf(BucketBudgetExhaustedError);
    expect(err.bucket).toBe("graphql");
    expect(err.remaining).toBe(0);
    expect(err.resetAt).toBe(1234567000);
    expect(err.argv).toEqual(["gh", "issue", "list", "--json", "x"]);
    expect(err.message).toContain("graphql budget exhausted");
  });
});

describe("cost_delta on audit rows", () => {
  test("steady-state rows record cost_delta = 0 (cache fresh, no observable diff)", () => {
    const audit = makeAuditCapture();
    const deps: RateLimitDeps = {
      rawRunner: makeRunner({
        core: { limit: 5000, remaining: 4900, reset: 9999 },
        graphql: { limit: 5000, remaining: 4900, reset: 9999 },
        search: { limit: 30, remaining: 30, reset: 9999 },
      }),
      now: fixedNow(1_000_000),
      auditPath: () => "/tmp/audit.jsonl",
      ...audit,
    };
    const gate = gateGhArgv(["gh", "api", "user"], deps);
    recordGhResult(
      ["gh", "api", "user"],
      gate!.bucket,
      gate!.remainingBefore,
      { stdout: "alice", stderr: "", status: 0 },
      deps,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.cost_delta).toBe(0);
  });

  test("rate-limit-exhausted stderr path captures non-zero cost_delta", () => {
    const audit = makeAuditCapture();
    let resources: RateLimitResources = {
      core: { limit: 5000, remaining: 4900, reset: 9999 },
      graphql: { limit: 5000, remaining: 4900, reset: 9999 },
      search: { limit: 30, remaining: 30, reset: 9999 },
    };
    const runner = (cmd: string[]): CommandResult => {
      if (cmd[1] === "api" && cmd[2] === "rate_limit") {
        return { stdout: rateLimitStdout(resources), stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 0 };
    };
    const deps: RateLimitDeps = {
      rawRunner: runner,
      now: fixedNow(1_000_000),
      auditPath: () => "/tmp/audit.jsonl",
      ...audit,
    };
    const gate = gateGhArgv(["gh", "issue", "list", "--json", "number"], deps);
    resources = {
      core: { limit: 5000, remaining: 4900, reset: 9999 },
      graphql: { limit: 5000, remaining: 4895, reset: 9999 },
      search: { limit: 30, remaining: 30, reset: 9999 },
    };
    expect(() =>
      recordGhResult(
        ["gh", "issue", "list", "--json", "number"],
        gate!.bucket,
        gate!.remainingBefore,
        { stdout: "", stderr: "GraphQL: API rate limit exceeded for user ID 1", status: 1 },
        deps,
      ),
    ).toThrow(GraphQLBudgetExhaustedError);
    expect(audit.rows[0]!.cost_delta).toBe(5);
  });
});

describe("SweepCounter (begin/get/end)", () => {
  test("beginSweep captures start snapshots; calls accumulate; endSweep reconciles total", () => {
    let resources: RateLimitResources = {
      core: { limit: 5000, remaining: 5000, reset: 9999 },
      graphql: { limit: 5000, remaining: 5000, reset: 9999 },
      search: { limit: 30, remaining: 30, reset: 9999 },
    };
    const audit = makeAuditCapture();
    const runner = (cmd: string[]): CommandResult => {
      if (cmd[1] === "api" && cmd[2] === "rate_limit") {
        return { stdout: rateLimitStdout(resources), stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 0 };
    };
    const deps: RateLimitDeps = {
      rawRunner: runner,
      now: fixedNow(1_000_000),
      auditPath: () => "/tmp/audit.jsonl",
      ...audit,
    };

    const sweep = beginSweep("triage-status", deps);
    expect(sweep.scope).toBe("triage-status");
    expect(sweep.startSnapshots.graphql).toBe(5000);

    for (let i = 0; i < 3; i += 1) {
      const gate = gateGhArgv(["gh", "issue", "list", "--json", "number"], deps);
      recordGhResult(
        ["gh", "issue", "list", "--json", "number"],
        gate!.bucket,
        gate!.remainingBefore,
        { stdout: "[]", stderr: "", status: 0 },
        deps,
      );
    }

    const live = getSweepCost();
    expect(live!.callsByBucket.graphql).toBe(3);

    // Simulate the cumulative cost the GH-side actually saw.
    resources = {
      core: { limit: 5000, remaining: 5000, reset: 9999 },
      graphql: { limit: 5000, remaining: 4994, reset: 9999 },
      search: { limit: 30, remaining: 30, reset: 9999 },
    };
    const finalised = endSweep(deps);
    expect(finalised!.callsByBucket.graphql).toBe(3);
    expect(finalised!.costsByBucket.graphql).toBe(6);
    expect(getSweepCost()).toBeNull();
  });

  test("getSweepCost returns null when no sweep is active", () => {
    expect(getSweepCost()).toBeNull();
  });
});

describe("estimateSweepCost", () => {
  let tmpDir: string;
  let auditFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "prx-rate-limit-"));
    auditFile = join(tmpDir, "audit.jsonl");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeRows(rows: Partial<RateLimitAuditEntry>[]): void {
    const body = rows
      .map((row) =>
        JSON.stringify({
          ts: "2026-05-02T00:00:00.000Z",
          argv: ["gh"],
          bucket: "graphql",
          remaining_before: null,
          remaining_after: null,
          exit_code: 0,
          threw: null,
          cost_delta: null,
          ...row,
        }),
      )
      .join("\n");
    writeFileSync(auditFile, `${body}\n`);
  }

  test("cold sample (no audit file) → fallback avg 2, sample.calls=0", () => {
    const deps: RateLimitDeps = { auditPath: () => auditFile };
    const est = estimateSweepCost(10, deps);
    expect(est.sample.calls).toBe(0);
    expect(est.sample.avg).toBe(2);
    expect(est.perBucket.graphql).toBe(20);
  });

  test("file with only zero/null deltas → still cold, fallback avg 2", () => {
    writeRows([
      { cost_delta: 0 },
      { cost_delta: null },
      { cost_delta: 0 },
    ]);
    const deps: RateLimitDeps = { auditPath: () => auditFile };
    const est = estimateSweepCost(5, deps);
    expect(est.sample.calls).toBe(0);
    expect(est.sample.avg).toBe(2);
    expect(est.perBucket.graphql).toBe(10);
  });

  test("real positive deltas → rolling average over the sample", () => {
    writeRows([
      { cost_delta: 1 },
      { cost_delta: 3 },
      { cost_delta: 2 },
      { cost_delta: 0 },
      { cost_delta: 4 },
    ]);
    const deps: RateLimitDeps = { auditPath: () => auditFile };
    const est = estimateSweepCost(10, deps);
    // sample = [1,3,2,4]; avg = 2.5; sample.calls = 4
    expect(est.sample.calls).toBe(4);
    expect(est.sample.avg).toBeCloseTo(2.5, 5);
    expect(est.perBucket.graphql).toBeCloseTo(25, 5);
  });

  test("non-graphql rows are ignored", () => {
    writeRows([
      { bucket: "core", cost_delta: 50 },
      { bucket: "search", cost_delta: 10 },
      { bucket: "graphql", cost_delta: 4 },
    ]);
    const deps: RateLimitDeps = { auditPath: () => auditFile };
    const est = estimateSweepCost(3, deps);
    expect(est.sample.calls).toBe(1);
    expect(est.sample.avg).toBe(4);
    expect(est.perBucket.graphql).toBe(12);
  });
});

describe("readRateLimitAuditRows (GH-1533)", () => {
  let tmpDir: string;
  let auditFile: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "prx-rate-limit-read-"));
    auditFile = join(tmpDir, "rate-limit.jsonl");
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test("returns [] when the file is absent", () => {
    expect(readRateLimitAuditRows({ auditPath: () => auditFile })).toEqual([]);
  });

  test("parses every well-formed row (with and without attribution fields), skipping garbage", () => {
    const lines = [
      // pre-GH-1533 row — no attribution fields
      JSON.stringify({ ts: "2026-05-12T10:00:00.000Z", argv: ["gh", "api", "user"], bucket: "core", remaining_before: 4900, remaining_after: 4899, exit_code: 0, threw: null, cost_delta: 1 }),
      // attributed row
      JSON.stringify({ ts: "2026-05-12T11:00:00.000Z", argv: ["gh", "issue", "list", "--json", "number"], bucket: "graphql", remaining_before: 4899, remaining_after: 4896, exit_code: 0, threw: null, cost_delta: 3, api: "graphql", verb: "triage.status", actor: "claude-code", operation: "issue.list", cost: 3, remaining: 4896, limit: 5000, reset_at: "2026-05-12T12:00:00.000Z", duration_ms: 220 }),
      "{ not json",
      JSON.stringify({ ts: "2026-05-12T11:30:00.000Z", argv: 42 }), // wrong shape
      "",
    ];
    writeFileSync(auditFile, lines.join("\n"));
    const rows = readRateLimitAuditRows({ auditPath: () => auditFile });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ bucket: "core" });
    expect(rows[0]!.api).toBeUndefined();
    expect(rows[1]).toMatchObject({ api: "graphql", verb: "triage.status", operation: "issue.list", cost: 3 });
  });
});

describe("refreshBudget", () => {
  test("populates cache from gh api rate_limit response", () => {
    const deps: RateLimitDeps = {
      rawRunner: makeRunner({
        core: { limit: 5000, remaining: 4321, reset: 1700000000 },
        graphql: { limit: 5000, remaining: 1234, reset: 1700000000 },
        search: { limit: 30, remaining: 5, reset: 1700000000 },
      }),
      now: fixedNow(1_000_000),
    };
    const snaps = refreshBudget(deps);
    expect(snaps).not.toBeNull();
    const byBucket = new Map(snaps!.map((s) => [s.bucket, s]));
    expect(byBucket.get("core")!.remaining).toBe(4321);
    expect(byBucket.get("graphql")!.remaining).toBe(1234);
    expect(byBucket.get("search")!.remaining).toBe(5);
    expect(byBucket.get("core")!.resetAt).toBe(1700000000_000);
  });

  test("returns null on bad JSON, leaves cache untouched", () => {
    const deps: RateLimitDeps = {
      rawRunner: () => ({ stdout: "not-json", stderr: "", status: 0 }),
      now: fixedNow(1_000_000),
    };
    expect(refreshBudget(deps)).toBeNull();
  });

  test("returns null on non-zero exit", () => {
    const deps: RateLimitDeps = {
      rawRunner: () => ({ stdout: "", stderr: "auth", status: 1 }),
      now: fixedNow(1_000_000),
    };
    expect(refreshBudget(deps)).toBeNull();
  });
});
