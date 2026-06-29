// GH-1603 — failure-mode catalog + write-path tests for `prx fetch gh-issues`.
//
// Replaces the GH-1245 spike catalog wholesale: the shell-out `bd github
// sync --dry-run` heuristic is dead (docs/fetch-spike-retro.md §Q3), so
// all transport mocks now drive a `GhGraphqlRunner`-shaped seam. New
// rows pin I-F4 (page atomicity), I-F5 (watermark monotonicity), and
// I-F6 (dry-run no-writes).

import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeFetchPlan,
  FetchGhIssuesError,
  formatFetchGhIssuesJson,
  runFetchGhIssues,
  type FetchGhIssuesResult,
} from "../../src/fetch/gh-issues.ts";
import type { GhRawRunner } from "../../src/fetch/gh-issues-graphql.ts";
import {
  __resetRateLimitCacheForTesting,
  configureRateLimit,
  type RateLimitDeps,
} from "@bounded-systems/github-budget";
import type { BdExecResult } from "@bounded-systems/bd";
import type { CommandResult } from "../../src/pr-state/github.ts";
import type { FetchBudget, FetchGhIssuesInput } from "../../src/fetch/types.ts";

const DRY_RUN_INPUT: FetchGhIssuesInput = {
  source: "gh-issues",
  repo: "bdelanghe/ai-home",
  dryRun: true,
};

const LIVE_INPUT: FetchGhIssuesInput = {
  source: "gh-issues",
  repo: "bdelanghe/ai-home",
  dryRun: false,
};

const NOW = new Date("2026-05-13T12:00:00.000Z");
const RESET_AT_ISO = new Date(NOW.getTime() + 3600_000).toISOString();

function budget(remaining: number): FetchBudget {
  return {
    source: "gh-issues",
    pointsAvailable: remaining,
    resetAt: RESET_AT_ISO,
    dailySpentPoints: 0,
  };
}

beforeEach(() => {
  __resetRateLimitCacheForTesting();
  configureRateLimit({});
});

describe("computeFetchPlan — pure cost projection", () => {
  test("empty corpus → go, 0 points, watermarkAdvanceTo = now", () => {
    const plan = computeFetchPlan({
      input: DRY_RUN_INPUT,
      budget: budget(4900),
      watermark: { since: null },
      corpusSize: 0,
      sweepAvgPoints: 2,
      now: NOW,
    });
    expect(plan.decision).toBe("go");
    expect(plan.estimatedPoints).toBe(0);
    expect(plan.estimatedRequests).toBe(0);
    expect(plan.watermarkAdvanceTo).toBe(NOW.toISOString());
  });

  test("single-page corpus → go, exactly 1 request projected", () => {
    const plan = computeFetchPlan({
      input: DRY_RUN_INPUT,
      budget: budget(4900),
      watermark: { since: null },
      corpusSize: 80,
      sweepAvgPoints: 2,
      now: NOW,
    });
    expect(plan.decision).toBe("go");
    expect(plan.estimatedRequests).toBe(1);
    expect(plan.estimatedPoints).toBeGreaterThan(0);
  });

  test("below safety margin → skip", () => {
    const plan = computeFetchPlan({
      input: DRY_RUN_INPUT,
      budget: budget(50),
      watermark: { since: null },
      corpusSize: 2000, // 20 requests × 2 points = 40 points × 1.5 margin = 60 required
      sweepAvgPoints: 2,
      safetyMargin: 1.5,
      now: NOW,
    });
    expect(plan.decision).toBe("skip");
    expect(plan.rationale).toMatch(/budget gate/);
  });

  test("hard exhaust → fail (I-F3)", () => {
    const plan = computeFetchPlan({
      input: DRY_RUN_INPUT,
      budget: budget(0),
      watermark: { since: null },
      corpusSize: 100,
      sweepAvgPoints: 2,
      now: NOW,
    });
    expect(plan.decision).toBe("fail");
    expect(plan.rationale).toMatch(/hard rate exhaust/);
  });

  test("gate threw flag → fail even when remaining > 0", () => {
    const plan = computeFetchPlan({
      input: DRY_RUN_INPUT,
      budget: budget(4900),
      watermark: { since: null },
      corpusSize: 100,
      sweepAvgPoints: 2,
      now: NOW,
      gateThrew: true,
    });
    expect(plan.decision).toBe("fail");
  });

  test("input.budget override replaces safetyMargin × estimated", () => {
    const plan = computeFetchPlan({
      input: { ...DRY_RUN_INPUT, budget: 10000 },
      budget: budget(4900),
      watermark: { since: null },
      corpusSize: 100,
      sweepAvgPoints: 2,
      now: NOW,
    });
    expect(plan.decision).toBe("skip");
    expect(plan.rationale).toMatch(/10000 required/);
  });
});

// ─── GraphQL response builders ───────────────────────────────────────────────
//
// `gh api graphql -f query=...` returns JSON on stdout. The transport
// expects either a count probe (`data.repository.issues.totalCount`) or
// a page (`data.repository.issues.{ pageInfo, nodes }`) with a top-level
// `rateLimit { cost remaining limit resetAt }` block on every response.

type GhCallKind = "count" | "page";

function classifyArgv(argv: readonly string[]): GhCallKind | null {
  if (argv[0] !== "gh" || argv[1] !== "api" || argv[2] !== "graphql") return null;
  const queryField = argv
    .map((s, i) => (s === "-f" && argv[i + 1]?.startsWith("query=") ? argv[i + 1] : null))
    .find((v): v is string => v !== null);
  if (!queryField) return null;
  if (queryField.includes("FetchIssuesCount")) return "count";
  if (queryField.includes("FetchIssuesPage")) return "page";
  return null;
}

function countResponse(totalCount: number): string {
  return JSON.stringify({
    data: {
      repository: { issues: { totalCount } },
      rateLimit: { cost: 1, remaining: 4995, limit: 5000, resetAt: RESET_AT_ISO },
    },
  });
}

function pageResponse(
  rows: Array<{ number: number; url: string; updatedAt: string; state: string; title: string }>,
  hasNextPage: boolean,
  endCursor: string | null,
  rateLimitCost = 5,
): string {
  return JSON.stringify({
    data: {
      repository: {
        issues: {
          pageInfo: { hasNextPage, endCursor },
          nodes: rows,
        },
      },
      rateLimit: {
        cost: rateLimitCost,
        remaining: 4900,
        limit: 5000,
        resetAt: RESET_AT_ISO,
      },
    },
  });
}

type MockedDeps = {
  cwd: string;
  ghRunner: GhRawRunner;
  ghCalls: string[][];
  bdSpawnCalls: Array<{ subcommand: string; args: string[] }>;
  bdSetCalls: string[][];
  bdConfigGetCalls: number;
  rateLimit: RateLimitDeps;
};

type MockOpts = {
  /** GraphQL bucket budget remaining. null → simulate rate_limit probe failure. */
  rateRemaining: number | null;
  /** Successive graphql responses (count first, then pages in order). */
  ghResponses: Array<
    | { kind: "count"; totalCount: number }
    | {
        kind: "page";
        rows: Array<{
          number: number;
          url: string;
          updatedAt: string;
          state: string;
          title: string;
        }>;
        hasNextPage: boolean;
        endCursor: string | null;
        cost?: number;
      }
    | { kind: "exit-nonzero"; status: number; stderr: string }
    | { kind: "garbage-stdout" }
  >;
  /** Persisted watermark; null → unset (bd "not set" sentinel). */
  watermarkValue?: string | null;
  /** Default: every `bd update` succeeds. */
  bdUpdateBehavior?: (rowIndex: number) => { exitCode: number; stderr?: string };
};

function setupMocks(opts: MockOpts): MockedDeps {
  const cwd = mkdtempSync(join(tmpdir(), "prx-fetch-test-"));
  const ghCalls: string[][] = [];
  const bdSpawnCalls: Array<{ subcommand: string; args: string[] }> = [];
  const bdSetCalls: string[][] = [];
  let bdConfigGetCalls = 0;
  let liveWatermark: string | null = opts.watermarkValue ?? null;

  // Drive successive graphql responses in caller-declared order. The first
  // matching kind is consumed; tests fail fast if the orchestrator does
  // more calls than the catalog provided.
  let nextResponseIdx = 0;
  const ghRunner: GhRawRunner = (argv): CommandResult => {
    ghCalls.push([...argv]);
    const kind = classifyArgv(argv);
    if (kind === null) {
      return { stdout: "", stderr: `unexpected gh argv: ${argv.join(" ")}`, status: 1 };
    }
    if (nextResponseIdx >= opts.ghResponses.length) {
      return {
        stdout: "",
        stderr: `gh runner: ran out of canned responses (next was ${kind})`,
        status: 1,
      };
    }
    const next = opts.ghResponses[nextResponseIdx]!;
    nextResponseIdx += 1;
    if (next.kind === "exit-nonzero") {
      return { stdout: "", stderr: next.stderr, status: next.status };
    }
    if (next.kind === "garbage-stdout") {
      return { stdout: "{this is not json", stderr: "", status: 0 };
    }
    if (next.kind === "count" && kind === "count") {
      return { stdout: countResponse(next.totalCount), stderr: "", status: 0 };
    }
    if (next.kind === "page" && kind === "page") {
      return {
        stdout: pageResponse(next.rows, next.hasNextPage, next.endCursor, next.cost),
        stderr: "",
        status: 0,
      };
    }
    return {
      stdout: "",
      stderr: `gh runner: response/argv mismatch (expected ${next.kind}, got ${kind})`,
      status: 1,
    };
  };

  // `bd update` mock — counts spawns + lets tests inject per-row failures.
  const execBd = (cmdOpts: { subcommand: string; args: string[] }): BdExecResult => {
    bdSpawnCalls.push({ subcommand: cmdOpts.subcommand, args: cmdOpts.args });
    if (cmdOpts.subcommand === "update") {
      const rowIdx = bdSpawnCalls.filter((c) => c.subcommand === "update").length - 1;
      const beh = opts.bdUpdateBehavior?.(rowIdx) ?? { exitCode: 0 };
      return {
        exitCode: beh.exitCode,
        stdout: "",
        stderr: beh.stderr ?? "",
        policy: null,
      };
    }
    return { exitCode: 0, stdout: "", stderr: "", policy: null };
  };

  // GH-296: the writer's bd update now runs `prx beads update …` through the
  // daemon (a sync runner). Record into the same bdSpawnCalls shape (subcommand
  // = cmd[2], args = cmd.slice(3)) so the existing update-count/failure
  // assertions hold; reuse bdUpdateBehavior for per-row failure injection.
  const run = (cmd: string[]): { status: number; stdout: string; stderr: string } => {
    const subcommand = cmd[2] ?? "";
    bdSpawnCalls.push({ subcommand, args: cmd.slice(3) });
    if (subcommand === "update") {
      const rowIdx = bdSpawnCalls.filter((c) => c.subcommand === "update").length - 1;
      const beh = opts.bdUpdateBehavior?.(rowIdx) ?? { exitCode: 0 };
      return { status: beh.exitCode, stdout: "", stderr: beh.stderr ?? "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  // Watermark cursor fs seam — prx-82b 2e.2: the cursor is a host-local FILE now,
  // not `bd config`. Simulate it in-memory (`liveWatermark`). `bdSetCalls` keeps
  // its bd-argv shape (`[...,"set",key,value]`) so the `set[0][4]` value
  // assertions stay unchanged. `env` returns a HOME so the cursor dir resolves.
  const watermarkFs = {
    env: ((k: string) => (k === "HOME" ? cwd : undefined)) as never,
    readFile: (_p: string): string => {
      bdConfigGetCalls += 1;
      if (liveWatermark === null) throw new Error("ENOENT (cursor absent)");
      return liveWatermark;
    },
    writeFile: (_p: string, data: string): void => {
      bdSetCalls.push(["bd", "config", "set", "prx.fetch.gh-issues.watermark", data]);
      liveWatermark = data;
    },
  };

  // gh api rate_limit probe — non-graphql; routed through the raw runner
  // configured in `rateLimit.rawRunner`.
  const rawRunner = (cmd: string[]): CommandResult => {
    if (opts.rateRemaining === null) {
      return { stdout: "", stderr: "rate-limit probe failed", status: 1 };
    }
    return {
      stdout: JSON.stringify({
        resources: {
          core: { limit: 5000, remaining: 5000, reset: 9999 },
          graphql: {
            limit: 5000,
            remaining: opts.rateRemaining,
            reset: Math.floor(new Date("2026-05-13T13:00:00.000Z").getTime() / 1000),
          },
          search: { limit: 30, remaining: 30, reset: 9999 },
        },
      }),
      stderr: "",
      status: 0,
    };
  };

  const rateLimit: RateLimitDeps = {
    rawRunner,
    now: () => NOW,
    auditPath: () => join(cwd, "rate-limit.jsonl"),
    homeDir: () => cwd,
    threshold: () => 0,
  };

  return {
    cwd,
    ghRunner,
    ghCalls,
    bdSpawnCalls,
    bdSetCalls,
    bdConfigGetCalls,
    rateLimit,
    watermarkFs,
    execBd,
    run,
  } as any;
}

// GH-1649 — a deterministic URL→bd canonical long id for the orchestrator
// tests. The shape matches `BD_LONG_ID_RE` so the writer's positional id is
// a faithful stand-in for what `resolveFromBeads` returns in production; the
// orchestrator's resolver/create/snapshot seams are injected here so the
// live path never touches a real bd binary.
function longIdForUrl(url: string): string {
  const n = Number(url.match(/issues\/(\d+)/)?.[1] ?? "0");
  return `ai-home-1700000000000-${n}-deadbeef`;
}

function makeDeps(mocks: ReturnType<typeof setupMocks>) {
  const m = mocks as unknown as MockedDeps & {
    watermarkFs: {
      env: (k: string) => string | undefined;
      readFile: (p: string) => string;
      writeFile: (p: string, data: string) => void;
    };
    execBd: (opts: { subcommand: string; args: string[] }) => BdExecResult;
    run: (cmd: string[]) => { status: number; stdout: string; stderr: string };
  };
  return {
    cwd: m.cwd,
    graphql: { rawRunner: m.ghRunner, rateLimit: m.rateLimit },
    writer: { run: m.run },
    watermarkFs: m.watermarkFs,
    rateLimit: m.rateLimit,
    // GH-1649: keep the snapshot empty + resolve every row to a canonical
    // long id so the live path never spawns a real bd (loadAllBeads /
    // runIntakeMirror). Rows always resolve, so `createBead` is the
    // last-resort guard only.
    loadBeadsSnapshot: () => [],
    resolveBdId: (url: string) => longIdForUrl(url),
    createBead: (_args: { ghId: string; repo: string }) => ({
      exitCode: 0,
      createdBdId: `ai-home-1700000000000-999-deadbeef`,
    }),
    now: () => NOW,
  };
}

function bdUpdateCount(mocks: ReturnType<typeof setupMocks>): number {
  const m = mocks as unknown as { bdSpawnCalls: Array<{ subcommand: string }> };
  return m.bdSpawnCalls.filter((c) => c.subcommand === "update").length;
}

// ─── Failure-mode + write-path catalog ───────────────────────────────────────

describe("runFetchGhIssues — failure-mode catalog", () => {
  test("Budget gate denies (skip) — remaining=50, totalCount=2000", () => {
    // 2000 / 100 = 20 requests × 2 sweepAvg = 40 estimated × 1.5 margin
    // = 60 required > 50 available → skip (I-F2).
    const mocks = setupMocks({
      rateRemaining: 50,
      ghResponses: [{ kind: "count", totalCount: 2000 }],
      watermarkValue: null,
    });
    const result = runFetchGhIssues(DRY_RUN_INPUT, makeDeps(mocks));
    expect(result.plan.decision).toBe("skip");
    expect(bdUpdateCount(mocks)).toBe(0);
    expect((mocks as unknown as MockedDeps).bdSetCalls).toHaveLength(0);
  });

  test("Hard rate exhaust (fail) — remaining=0", () => {
    const mocks = setupMocks({
      rateRemaining: 0,
      ghResponses: [{ kind: "count", totalCount: 100 }],
      watermarkValue: null,
    });
    const result = runFetchGhIssues(DRY_RUN_INPUT, makeDeps(mocks));
    expect(result.plan.decision).toBe("fail");
    expect(result.plan.rationale).toMatch(/hard rate exhaust/);
    expect(bdUpdateCount(mocks)).toBe(0);
  });

  test("rate_limit probe fails → NO_BUDGET", () => {
    const mocks = setupMocks({
      rateRemaining: null,
      ghResponses: [],
      watermarkValue: null,
    });
    let caught: unknown = null;
    try {
      runFetchGhIssues(DRY_RUN_INPUT, makeDeps(mocks));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FetchGhIssuesError);
    expect((caught as FetchGhIssuesError).code).toBe("NO_BUDGET");
    expect(bdUpdateCount(mocks)).toBe(0);
  });

  test("Malformed GraphQL response → GH_GRAPHQL_PARSE_FAILED", () => {
    const mocks = setupMocks({
      rateRemaining: 4900,
      ghResponses: [{ kind: "garbage-stdout" }],
      watermarkValue: null,
    });
    let caught: unknown = null;
    try {
      runFetchGhIssues(DRY_RUN_INPUT, makeDeps(mocks));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FetchGhIssuesError);
    expect((caught as FetchGhIssuesError).code).toBe("GH_GRAPHQL_PARSE_FAILED");
    expect(bdUpdateCount(mocks)).toBe(0);
  });

  test("Empty corpus (totalCount=0) → go, 0 writes, watermark advances", () => {
    const mocks = setupMocks({
      rateRemaining: 4900,
      ghResponses: [{ kind: "count", totalCount: 0 }],
      watermarkValue: null,
    });
    const result = runFetchGhIssues(LIVE_INPUT, makeDeps(mocks));
    expect(result.plan.decision).toBe("go");
    expect(result.corpusSize).toBe(0);
    // No pages to write; the live path short-circuits on empty plan.
    expect(bdUpdateCount(mocks)).toBe(0);
  });

  test("Single-page live corpus writes per-row + advances watermark", () => {
    const rows = [
      {
        number: 1,
        url: "https://github.com/x/y/issues/1",
        updatedAt: "2026-05-13T10:00:00Z",
        state: "OPEN",
        title: "first",
      },
      {
        number: 2,
        url: "https://github.com/x/y/issues/2",
        updatedAt: "2026-05-13T11:00:00Z",
        state: "OPEN",
        title: "second",
      },
    ];
    const mocks = setupMocks({
      rateRemaining: 4900,
      ghResponses: [
        { kind: "count", totalCount: 2 },
        { kind: "page", rows, hasNextPage: false, endCursor: null, cost: 5 },
      ],
      watermarkValue: null,
    });
    const result: FetchGhIssuesResult = runFetchGhIssues(LIVE_INPUT, makeDeps(mocks));
    expect(result.plan.decision).toBe("go");
    expect(bdUpdateCount(mocks)).toBe(2);
    expect(result.run?.totalRowsWritten).toBe(2);
    expect(result.run?.pagesCommitted).toBe(1);
    expect(result.run?.totalPointsSpent).toBe(5);
    const set = (mocks as unknown as MockedDeps).bdSetCalls;
    expect(set).toHaveLength(1);
    expect(set[0]![4]).toBe("2026-05-13T11:00:00Z"); // page max(updatedAt)

    // GH-1649 / I-F7: every `bd update` writes by canonical-long-id
    // positional (args[0]), never the bare `--external-ref`-first form that
    // would hit bd's last-touched fallback.
    const updateArgs = (mocks as unknown as MockedDeps).bdSpawnCalls
      .filter((c) => c.subcommand === "update")
      .map((c) => c.args);
    expect(updateArgs).toHaveLength(2);
    for (const args of updateArgs) {
      expect(args[0]!.startsWith("-")).toBe(false);
      expect(args[0]).toBe(longIdForUrl(args[2]!)); // args = [bdId, "--external-ref", url, …]
      expect(args[1]).toBe("--external-ref");
    }
  });
});

describe("I-F4 / I-F5 — page atomicity + watermark monotonicity", () => {
  test("Mid-fetch GraphQL exhaust — page-1 commits, page-2 graphql throws → exit 65, watermark at page-1 max", () => {
    const page1 = [
      {
        number: 1,
        url: "https://github.com/x/y/issues/1",
        updatedAt: "2026-05-13T10:00:00Z",
        state: "OPEN",
        title: "p1-1",
      },
    ];
    const mocks = setupMocks({
      rateRemaining: 4900,
      ghResponses: [
        { kind: "count", totalCount: 2 },
        { kind: "page", rows: page1, hasNextPage: true, endCursor: "CUR1", cost: 5 },
        { kind: "exit-nonzero", status: 1, stderr: "API rate limit exceeded" },
      ],
      watermarkValue: null,
    });
    let caught: unknown = null;
    try {
      runFetchGhIssues(LIVE_INPUT, makeDeps(mocks));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FetchGhIssuesError);
    // The `gh runner` test mock returns stderr that matches the rate-limit
    // signature, so `recordGhResult` raises a `BucketBudgetExhaustedError`
    // (caught + wrapped as `BUDGET_EXHAUSTED`). Either propagation path is
    // I-F5-correct — what we assert is that page-1's write + watermark
    // advance survived.
    expect((caught as FetchGhIssuesError).code).toBe("BUDGET_EXHAUSTED");
    // page-1 wrote its row + advanced the watermark BEFORE page-2 blew up.
    expect(bdUpdateCount(mocks)).toBe(1);
    const set = (mocks as unknown as MockedDeps).bdSetCalls;
    expect(set).toHaveLength(1);
    expect(set[0]![4]).toBe("2026-05-13T10:00:00Z");
  });

  test("Partial-page bd write failure — second row's bd update exits non-zero → no watermark advance", () => {
    const page1 = [
      {
        number: 1,
        url: "https://github.com/x/y/issues/1",
        updatedAt: "2026-05-13T10:00:00Z",
        state: "OPEN",
        title: "p1-1",
      },
      {
        number: 2,
        url: "https://github.com/x/y/issues/2",
        updatedAt: "2026-05-13T11:00:00Z",
        state: "OPEN",
        title: "p1-2",
      },
    ];
    const mocks = setupMocks({
      rateRemaining: 4900,
      ghResponses: [
        { kind: "count", totalCount: 2 },
        { kind: "page", rows: page1, hasNextPage: false, endCursor: null, cost: 5 },
      ],
      watermarkValue: null,
      bdUpdateBehavior: (i) =>
        i === 1 ? { exitCode: 1, stderr: "bd: connection refused" } : { exitCode: 0 },
    });
    let caught: unknown = null;
    try {
      runFetchGhIssues(LIVE_INPUT, makeDeps(mocks));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FetchGhIssuesError);
    expect((caught as FetchGhIssuesError).code).toBe("FETCH_WRITE_FAILED");
    // bd update was called twice (the first succeeded, the second failed).
    expect(bdUpdateCount(mocks)).toBe(2);
    // I-F4 + I-F5: the page's watermark advance never fired.
    expect((mocks as unknown as MockedDeps).bdSetCalls).toHaveLength(0);
  });

  test("Watermark non-regression on retry — second run with prior watermark T1 must not regress", () => {
    const T1 = "2026-05-12T00:00:00Z";
    const mocks = setupMocks({
      rateRemaining: 4900,
      ghResponses: [{ kind: "count", totalCount: 0 }],
      watermarkValue: T1,
    });
    const result = runFetchGhIssues(LIVE_INPUT, makeDeps(mocks));
    expect(result.watermark.since).toBe(T1);
    // No corpus, no writes — but I-F5 still requires that we don't
    // accidentally clobber the prior watermark.
    expect((mocks as unknown as MockedDeps).bdSetCalls).toHaveLength(0);
  });
});

describe("I-F6 — dry-run no-writes", () => {
  test("dryRun: true issues exactly one graphql call + zero bd writes", () => {
    const mocks = setupMocks({
      rateRemaining: 4900,
      ghResponses: [{ kind: "count", totalCount: 250 }],
      watermarkValue: null,
    });
    runFetchGhIssues(DRY_RUN_INPUT, makeDeps(mocks));
    // Exactly one graphql call — the count probe. No paginated page fetches.
    expect((mocks as unknown as MockedDeps).ghCalls).toHaveLength(1);
    // Zero bd update calls + zero bd config set (watermark) calls.
    expect(bdUpdateCount(mocks)).toBe(0);
    expect((mocks as unknown as MockedDeps).bdSetCalls).toHaveLength(0);
  });
});

describe("runFetchGhIssues — purity", () => {
  test("two runs with identical mocks produce identical envelopes", () => {
    const makeRun = (): FetchGhIssuesResult => {
      const mocks = setupMocks({
        rateRemaining: 4900,
        ghResponses: [{ kind: "count", totalCount: 100 }],
        watermarkValue: "2026-05-12T00:00:00Z",
      });
      return runFetchGhIssues(DRY_RUN_INPUT, makeDeps(mocks));
    };
    const a = makeRun();
    const b = makeRun();
    expect(b.plan).toEqual(a.plan);
    expect(b.watermark).toEqual(a.watermark);
    expect(b.corpusSize).toBe(a.corpusSize);
  });
});

describe("formatFetchGhIssuesJson — envelope shape", () => {
  test("emits a single _summary line with the decision fields", () => {
    const mocks = setupMocks({
      rateRemaining: 4900,
      ghResponses: [{ kind: "count", totalCount: 47 }],
      watermarkValue: null,
    });
    const result = runFetchGhIssues(DRY_RUN_INPUT, makeDeps(mocks));
    const text = formatFetchGhIssuesJson(result);
    const parsed = JSON.parse(text);
    expect(parsed._summary.source).toBe("gh-issues");
    expect(parsed._summary.decision).toBe("go");
    expect(parsed._summary.corpusSize).toBe(47);
    expect(parsed._summary.estimatedRequests).toBe(1);
    expect(parsed._summary.run).toBeNull(); // dry-run leaves `run` null
  });
});
