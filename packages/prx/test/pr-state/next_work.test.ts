// GH-1510 — fixture-driven tests for the multi-thread next-work picker.
// GH-1616 — extended with catalog-event audit-emission assertions.
// GH-1617 — adds triage_backlog and plan_paused thread classification tests.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuditSinkDeps } from "../../src/audit/sink.ts";
import { BdReadyExplainEnvelopeSchema, type BdReadyCandidate } from "../../src/beads/ready.ts";
import type { GetBdReadyResult } from "../../src/beads/ready_cache.ts";
import { derivePausedPlans, nextWork, DEFAULT_THREAD_ORDER } from "../../src/pr-state/next_work.ts";
import type { BoardStatusResult, BoardUnit, BoardColumn } from "../../src/pr-state/github.ts";
import type { TransitionEntry } from "../../src/pr-state/transition_log.ts";
import type { TriageStatusResult } from "../../src/triage/triage.ts";

function captureAudit(): { rows: Record<string, unknown>[]; deps: AuditSinkDeps } {
  const rows: Record<string, unknown>[] = [];
  const deps: AuditSinkDeps = {
    stateDirOverride: "/tmp/prx-test-next-work-audit",
    appendFn: (_path: string, line: string) => {
      rows.push(JSON.parse(line) as Record<string, unknown>);
    },
    ensureDir: () => {},
    env: {},
  };
  return { rows, deps };
}

function eventsOf(rows: Record<string, unknown>[], prefix?: string): string[] {
  return rows
    .filter((r) => r.kind === "catalog-event")
    .map((r) => String(r.event))
    .filter((e) => (prefix ? e.startsWith(prefix) : true));
}

const MIXED_FIXTURE_PATH = new URL("../beads/fixtures/bd-ready-mixed.json", import.meta.url)
  .pathname;
const mixedFixture = BdReadyExplainEnvelopeSchema.parse(
  JSON.parse(readFileSync(MIXED_FIXTURE_PATH, "utf8")),
);

const FAKE_REPO = "owner/repo";

function bdReadyResult(
  ready: BdReadyCandidate[] = mixedFixture.ready,
  blocked: BdReadyCandidate[] = mixedFixture.blocked,
): GetBdReadyResult {
  return {
    cache: {
      run_id: "test-run",
      queried_at: new Date().toISOString(),
      ttl_seconds: 60,
      ready,
      blocked,
      edges: [],
    },
    stale: false,
    refreshed: false,
  };
}

function emptyBoard(units: BoardUnit[] = []): BoardStatusResult {
  return {
    source: "derived-board",
    repo: FAKE_REPO,
    remote_freshness: "fresh" as BoardStatusResult["remote_freshness"],
    units,
  };
}

function makeUnit(
  overrides: Partial<BoardUnit> & { branch: string; column: BoardColumn },
): BoardUnit {
  return {
    ticket: overrides.ticket ?? null,
    branch: overrides.branch,
    worktree_path: overrides.worktree_path ?? `/tmp/${overrides.branch}`,
    pr: overrides.pr ?? {
      exists: false,
      number: null,
      title: null,
      url: null,
      draft: null,
      checks: null,
      review: null,
      approvals: null,
      mergeable: null,
    },
    artifacts: overrides.artifacts ?? {
      worktree: true,
      branch: true,
      pr: false,
      ticket: !!overrides.ticket,
    },
    local: overrides.local ?? { clean: true, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
    column: overrides.column,
    reasons: overrides.reasons ?? [],
  };
}

function threadCount(result: ReturnType<typeof nextWork>, kind: string): number {
  return result.threads.find((t) => t.kind === kind)?.candidates.length ?? 0;
}

function threadIds(result: ReturnType<typeof nextWork>, kind: string): string[] {
  return result.threads.find((t) => t.kind === kind)?.candidates.map((c) => c.bd_id) ?? [];
}

// GH-1617: build an empty `TriageStatusResult` with overrides for the four
// row arrays. Tests pass this through `opts.triage` so the picker projects
// it deterministically.
function makeTriageSnapshot(
  overrides: Partial<
    Pick<TriageStatusResult, "issues" | "reverseOrphans" | "drift" | "stale">
  > = {},
): TriageStatusResult {
  const issues = overrides.issues ?? [];
  const reverseOrphans = overrides.reverseOrphans ?? [];
  const drift = overrides.drift ?? [];
  const stale = overrides.stale ?? [];
  return {
    repo: FAKE_REPO,
    canonical: "gh",
    totalOpen: issues.length,
    totalUntriaged: issues.length,
    totalReverseOrphans: reverseOrphans.length,
    totalDrift: drift.length,
    totalStale: stale.length,
    totalAxisConflicts: 0,
    issues,
    reverseOrphans,
    drift,
    stale,
    axisConflicts: [],
  };
}

// GH-1617: build a transition-log entry with sensible defaults so callers
// only have to spell out the fields under test.
function makeTransitionEntry(
  overrides: Partial<TransitionEntry> & { issue: string; actor: string; timestamp: string },
): TransitionEntry {
  return {
    id: overrides.id ?? `id-${overrides.issue}-${overrides.timestamp}`,
    issue: overrides.issue,
    state_from: overrides.state_from ?? "drafting",
    state_to: overrides.state_to ?? "drafting",
    actor: overrides.actor,
    artifact: overrides.artifact ?? `branch:${overrides.issue}`,
    timestamp: overrides.timestamp,
    proof: overrides.proof,
  };
}

describe("nextWork — thread classification", () => {
  test("ready bd with no worktree → ready_to_start thread", () => {
    const result = nextWork("/dev/null", {
      bdReady: bdReadyResult(),
      board: emptyBoard(),
    });
    expect(threadIds(result, "ready_to_start").sort()).toEqual(
      ["ai-home-r1", "ai-home-r2", "ai-home-child-1"].sort(),
    );
    expect(threadCount(result, "blocked")).toBe(3); // b1, b2, parent-1 from fixture
  });

  test("blocked bd surfaces in `blocked` thread, never in `ready_to_start`", () => {
    const result = nextWork("/dev/null", {
      bdReady: bdReadyResult(),
      board: emptyBoard(),
    });
    expect(threadIds(result, "ready_to_start")).not.toContain("ai-home-b1");
    expect(threadIds(result, "blocked")).toContain("ai-home-b1");
  });

  test("orphan (cleanup_pending column) surfaces in orphan_cleanup", () => {
    const board = emptyBoard([
      makeUnit({
        ticket: "GH-9001",
        branch: "GH-9001",
        column: "cleanup_pending",
        reasons: ["GH issue #9001 closed — orphaned artifacts"],
      }),
    ]);
    const result = nextWork("/dev/null", { bdReady: bdReadyResult(), board });
    // ai-home-r1's external_ref → GH-9001 in the fixture; should land in
    // orphan_cleanup, not ready_to_start.
    expect(threadIds(result, "orphan_cleanup")).toContain("ai-home-r1");
    expect(threadIds(result, "ready_to_start")).not.toContain("ai-home-r1");
  });

  test("executor in flight (committing/pushed/etc.) surfaces in executor_in_flight", () => {
    const board = emptyBoard([
      makeUnit({ ticket: "GH-9001", branch: "GH-9001", column: "committing" }),
      makeUnit({ ticket: "GH-9002", branch: "GH-9002", column: "review" }),
    ]);
    const result = nextWork("/dev/null", { bdReady: bdReadyResult(), board });
    expect(threadIds(result, "executor_in_flight").sort()).toEqual(
      ["ai-home-r1", "ai-home-r2"].sort(),
    );
  });

  test("ci_running column → pr_awaiting_ci thread", () => {
    const board = emptyBoard([
      makeUnit({ ticket: "GH-9001", branch: "GH-9001", column: "ci_running" }),
    ]);
    const result = nextWork("/dev/null", { bdReady: bdReadyResult(), board });
    expect(threadIds(result, "pr_awaiting_ci")).toEqual(["ai-home-r1"]);
  });

  test("worktree with no bd record → intake_queue", () => {
    const board = emptyBoard([
      makeUnit({ ticket: null, branch: "feature/no-bd", column: "committing" }),
    ]);
    const result = nextWork("/dev/null", { bdReady: bdReadyResult([], []), board });
    expect(threadIds(result, "intake_queue")).toEqual(["feature/no-bd"]);
  });

  test("merged/cleaned columns are filtered out (terminal)", () => {
    const board = emptyBoard([
      makeUnit({ ticket: "GH-9001", branch: "GH-9001", column: "merged" }),
      makeUnit({ ticket: "GH-9002", branch: "GH-9002", column: "cleaned" }),
    ]);
    const result = nextWork("/dev/null", { bdReady: bdReadyResult([], []), board });
    expect(threadCount(result, "intake_queue")).toBe(0);
    expect(threadCount(result, "ready_to_start")).toBe(0);
  });
});

describe("nextWork — output contract", () => {
  test("threads come back in default order", () => {
    const result = nextWork("/dev/null", {
      bdReady: bdReadyResult(),
      board: emptyBoard(),
    });
    expect(result.threads.map((t) => t.kind)).toEqual([...DEFAULT_THREAD_ORDER]);
  });

  test("source is the literal 'next-work'", () => {
    const result = nextWork("/dev/null", {
      bdReady: bdReadyResult(),
      board: emptyBoard(),
    });
    expect(result.source).toBe("next-work");
  });

  test("repo flows through from boardStatus", () => {
    const result = nextWork("/dev/null", {
      bdReady: bdReadyResult(),
      board: emptyBoard(),
    });
    expect(result.repo).toBe(FAKE_REPO);
  });

  test("cache.stale flag flows through", () => {
    const ready = bdReadyResult();
    ready.stale = true;
    ready.refreshed = true;
    const result = nextWork("/dev/null", { bdReady: ready, board: emptyBoard() });
    expect(result.cache.stale).toBe(true);
    expect(result.cache.refreshed).toBe(true);
  });

  test("within a thread, candidates sort by priority ascending (bd order)", () => {
    const result = nextWork("/dev/null", {
      bdReady: bdReadyResult(),
      board: emptyBoard(),
    });
    // r2 is priority=0 (critical), r1 is priority=1, child-1 is priority=2.
    expect(threadIds(result, "ready_to_start")).toEqual([
      "ai-home-r2",
      "ai-home-r1",
      "ai-home-child-1",
    ]);
  });

  test("explicit threadOrder is honored verbatim (filter view)", () => {
    const result = nextWork("/dev/null", {
      bdReady: bdReadyResult(),
      board: emptyBoard(),
      threadOrder: ["ready_to_start", "blocked"],
    });
    // Explicit override is taken as-is so callers can request a filtered
    // view; the TOML loader auto-completes when reading prx.toml.
    expect(result.threads.map((t) => t.kind)).toEqual(["ready_to_start", "blocked"]);
  });
});

describe("nextWork — triage_backlog projection (GH-1617, I-NW1)", () => {
  const NO_BD = bdReadyResult([], []);

  test("triage row with missing priority surfaces in triage_backlog", () => {
    const triage = makeTriageSnapshot({
      issues: [
        {
          number: 9500,
          title: "Tighten retry semantics",
          url: "https://github.com/owner/repo/issues/9500",
          labels: ["type::task"],
          beadsId: null,
          missing: ["priority"],
          unknownLabels: [],
          weakSignals: [],
        },
      ],
    });
    const result = nextWork("/dev/null", { bdReady: NO_BD, board: emptyBoard(), triage });
    expect(threadIds(result, "triage_backlog")).toEqual(["GH-9500"]);
    const row = result.threads.find((t) => t.kind === "triage_backlog")!.candidates[0]!;
    expect(row.reason).toBe("Untriaged: missing priority");
    expect(row.command).toBe("prx triage promote GH-9500");
    expect(row.gh_issue).toBe(9500);
  });

  test("drift row surfaces in triage_backlog with field-list reason", () => {
    const triage = makeTriageSnapshot({
      drift: [
        {
          issueNumber: 7777,
          beadsId: "ai-home-drift",
          fields: {
            title: { gh: "GH title", bd: "BD title" },
            priority: { gh: "high", bd: "medium" },
          },
        },
      ],
    });
    const result = nextWork("/dev/null", { bdReady: NO_BD, board: emptyBoard(), triage });
    const row = result.threads.find((t) => t.kind === "triage_backlog")!.candidates[0]!;
    expect(row.bd_id).toBe("ai-home-drift");
    expect(row.reason).toBe("Drift: title/priority");
    expect(row.command).toBe("prx triage apply");
  });

  test("stale row surfaces in triage_backlog with bd-close command", () => {
    const triage = makeTriageSnapshot({
      stale: [
        {
          beadsId: "ai-home-stale",
          issueNumber: 3030,
          url: "https://github.com/owner/repo/issues/3030",
          title: "Closed issue, bead still open",
          status: "open",
          priority: "medium",
          issueType: "task",
          reason: "gh-issue-closed",
        },
      ],
    });
    const result = nextWork("/dev/null", { bdReady: NO_BD, board: emptyBoard(), triage });
    const row = result.threads.find((t) => t.kind === "triage_backlog")!.candidates[0]!;
    expect(row.bd_id).toBe("ai-home-stale");
    expect(row.reason).toBe("Stale — linked GH issue closed");
    expect(row.command).toBe("bd update ai-home-stale --status closed");
    expect(row.priority).toBe(2);
  });

  // prx-3f1: reverse-orphans (bd records with no external_ref) are the normal
  // beads-first state, not a remediation orphan — they are informational only
  // and must NOT be projected into triage_backlog (no `prx beads publish`
  // candidate). I-NW1 excludes reverseOrphans from the projection.
  test("reverse orphan does NOT surface in triage_backlog (prx-3f1)", () => {
    const triage = makeTriageSnapshot({
      reverseOrphans: [
        {
          beadsId: "ai-home-orphan",
          title: "Beads-only memo",
          status: "open",
          priority: "low",
          issueType: "chore",
          reason: "no-external-ref",
        },
      ],
    });
    const result = nextWork("/dev/null", { bdReady: NO_BD, board: emptyBoard(), triage });
    const backlog = result.threads.find((t) => t.kind === "triage_backlog");
    const candidates = backlog?.candidates ?? [];
    expect(candidates.some((c) => c.bd_id === "ai-home-orphan")).toBe(false);
    expect(candidates.some((c) => c.command === "prx beads publish ai-home-orphan")).toBe(false);
  });

  test("unit in executor_in_flight is suppressed from triage_backlog (I-NW3)", () => {
    // ai-home-r1 → external_ref GH-9001. Place it in the executor surface AND
    // claim a drift row exists for the same bd id; expect the drift row to be
    // suppressed.
    const board = emptyBoard([
      makeUnit({ ticket: "GH-9001", branch: "GH-9001", column: "committing" }),
    ]);
    const triage = makeTriageSnapshot({
      drift: [
        {
          issueNumber: 9001,
          beadsId: "ai-home-r1",
          fields: { title: { gh: "x", bd: "y" } },
        },
      ],
    });
    const result = nextWork("/dev/null", { bdReady: bdReadyResult(), board, triage });
    expect(threadIds(result, "executor_in_flight")).toContain("ai-home-r1");
    expect(threadIds(result, "triage_backlog")).not.toContain("ai-home-r1");
  });
});

describe("nextWork — plan_paused projection (GH-1617, I-NW2)", () => {
  const NOW = new Date("2026-05-13T12:00:00.000Z");

  test("planning entry older than TTL with no executor entry surfaces", () => {
    const entries: TransitionEntry[] = [
      makeTransitionEntry({
        issue: "GH-9700",
        actor: "planner_agent",
        timestamp: "2026-05-10T10:00:00.000Z",
      }),
    ];
    const result = nextWork("/dev/null", {
      bdReady: bdReadyResult([], []),
      board: emptyBoard(),
      transitionLog: entries,
      now: NOW,
    });
    const row = result.threads.find((t) => t.kind === "plan_paused")!.candidates[0]!;
    expect(row.bd_id).toBe("GH-9700");
    expect(row.command).toBe("prx plan session GH-9700");
    expect(row.reason).toContain("Plan paused since");
  });

  test("recent planning entry (within TTL) does NOT surface in plan_paused", () => {
    const entries: TransitionEntry[] = [
      makeTransitionEntry({
        issue: "GH-9701",
        actor: "planner_agent",
        timestamp: "2026-05-13T11:30:00.000Z",
      }),
    ];
    const result = nextWork("/dev/null", {
      bdReady: bdReadyResult([], []),
      board: emptyBoard(),
      transitionLog: entries,
      now: NOW,
    });
    expect(threadCount(result, "plan_paused")).toBe(0);
  });

  test("subsequent executor entry suppresses paused-plan signal", () => {
    const entries: TransitionEntry[] = [
      makeTransitionEntry({
        issue: "GH-9702",
        actor: "planner_agent",
        timestamp: "2026-05-09T10:00:00.000Z",
      }),
      makeTransitionEntry({
        issue: "GH-9702",
        actor: "executor_agent",
        timestamp: "2026-05-10T10:00:00.000Z",
      }),
    ];
    const result = nextWork("/dev/null", {
      bdReady: bdReadyResult([], []),
      board: emptyBoard(),
      transitionLog: entries,
      now: NOW,
    });
    expect(threadCount(result, "plan_paused")).toBe(0);
  });

  test("plan paused for unit in executor_in_flight is suppressed (I-NW3)", () => {
    // ai-home-r1 → external_ref → GH-9001. The board has it in `committing`
    // (executor_in_flight). A stale planner entry for the same GH branch
    // should NOT also surface in plan_paused.
    const board = emptyBoard([
      makeUnit({ ticket: "GH-9001", branch: "GH-9001", column: "committing" }),
    ]);
    const entries: TransitionEntry[] = [
      makeTransitionEntry({
        issue: "GH-9001",
        actor: "planner_agent",
        timestamp: "2026-05-09T10:00:00.000Z",
      }),
    ];
    const result = nextWork("/dev/null", {
      bdReady: bdReadyResult(),
      board,
      transitionLog: entries,
      now: NOW,
    });
    expect(threadIds(result, "executor_in_flight")).toContain("ai-home-r1");
    expect(threadIds(result, "plan_paused")).not.toContain("ai-home-r1");
    expect(threadIds(result, "plan_paused")).not.toContain("GH-9001");
  });

  test("within plan_paused, candidates sort by priority", () => {
    const entries: TransitionEntry[] = [
      makeTransitionEntry({
        issue: "GH-9710",
        actor: "planner_agent",
        timestamp: "2026-05-09T10:00:00.000Z",
      }),
      makeTransitionEntry({
        issue: "GH-9711",
        actor: "planner_agent",
        timestamp: "2026-05-09T11:00:00.000Z",
      }),
    ];
    const result = nextWork("/dev/null", {
      bdReady: bdReadyResult([], []),
      board: emptyBoard(),
      transitionLog: entries,
      now: NOW,
    });
    // Both fall back to synthetic priority=2 (no bd join), so sort is by
    // bd_id ascending — GH-9710 before GH-9711.
    expect(threadIds(result, "plan_paused")).toEqual(["GH-9710", "GH-9711"]);
  });

  test("missing transition log → plan_paused empty (no throw)", () => {
    // No `opts.transitionLog` and `/dev/null` repo path → readTransitionLog
    // sees no file and returns []. Picker must not throw.
    const result = nextWork("/dev/null", {
      bdReady: bdReadyResult([], []),
      board: emptyBoard(),
    });
    expect(threadCount(result, "plan_paused")).toBe(0);
  });

  test("planner-completion (newer planner entry) writing executor state suppresses paused signal", () => {
    // I-NW2: a later ROLE_PLANNER_COMPLETED implies the planner finished
    // handing off. We model this as the most-recent entry being a non-
    // planner-role actor (e.g. executor) — the predicate flips to "not
    // paused" because the planner is no longer the most-recent voice.
    const entries: TransitionEntry[] = [
      makeTransitionEntry({
        issue: "GH-9720",
        actor: "planner_agent",
        timestamp: "2026-05-09T10:00:00.000Z",
      }),
      makeTransitionEntry({
        issue: "GH-9720",
        actor: "executor_agent",
        timestamp: "2026-05-11T10:00:00.000Z",
      }),
    ];
    const result = nextWork("/dev/null", {
      bdReady: bdReadyResult([], []),
      board: emptyBoard(),
      transitionLog: entries,
      now: NOW,
    });
    expect(threadCount(result, "plan_paused")).toBe(0);
  });
});

describe("derivePausedPlans (GH-1617, I-NW2 pure predicate)", () => {
  const NOW = new Date("2026-05-13T12:00:00.000Z");
  const TTL = 24 * 60 * 60;

  test("planning entry past TTL → paused", () => {
    const paused = derivePausedPlans(
      [
        makeTransitionEntry({
          issue: "GH-1",
          actor: "planner_agent",
          timestamp: "2026-05-11T11:00:00.000Z", // > 24h before NOW
        }),
      ],
      NOW,
      TTL,
    );
    expect([...paused.keys()]).toEqual(["GH-1"]);
  });

  test("planning entry within TTL → not paused", () => {
    const paused = derivePausedPlans(
      [
        makeTransitionEntry({
          issue: "GH-2",
          actor: "planner_agent",
          timestamp: "2026-05-13T08:00:00.000Z", // < 24h before NOW
        }),
      ],
      NOW,
      TTL,
    );
    expect([...paused.keys()]).toEqual([]);
  });

  test("entries with null issue are skipped", () => {
    const paused = derivePausedPlans(
      [
        {
          id: "x",
          issue: null,
          state_from: "drafting",
          state_to: "drafting",
          actor: "planner_agent",
          artifact: null,
          timestamp: "2026-05-09T10:00:00.000Z",
        },
      ],
      NOW,
      TTL,
    );
    expect(paused.size).toBe(0);
  });

  test("non-planner actor's stale entry → not paused", () => {
    const paused = derivePausedPlans(
      [
        makeTransitionEntry({
          issue: "GH-3",
          actor: "tester_agent",
          timestamp: "2026-05-09T10:00:00.000Z",
        }),
      ],
      NOW,
      TTL,
    );
    expect(paused.size).toBe(0);
  });

  test("`agent.planner` actor alias is recognized", () => {
    const paused = derivePausedPlans(
      [
        makeTransitionEntry({
          issue: "GH-4",
          actor: "agent.planner",
          timestamp: "2026-05-09T10:00:00.000Z",
        }),
      ],
      NOW,
      TTL,
    );
    expect([...paused.keys()]).toEqual(["GH-4"]);
  });
});

describe("nextWork — catalog-event audit emissions (GH-1616)", () => {
  test("fresh cache emits exactly one BD_READY_CACHE_HIT", () => {
    const { rows, deps } = captureAudit();
    const ready = bdReadyResult();
    expect(ready.stale).toBe(false);
    expect(ready.refreshed).toBe(false);
    nextWork("/dev/null", { bdReady: ready, board: emptyBoard(), auditDeps: deps });
    const cacheEvents = eventsOf(rows, "BD_READY_CACHE");
    expect(cacheEvents).toEqual(["BD_READY_CACHE_HIT"]);
  });

  test("stale + refreshed emits STALE_SERVED then REFRESHED in order", () => {
    const { rows, deps } = captureAudit();
    const ready = bdReadyResult();
    ready.stale = true;
    ready.refreshed = true;
    nextWork("/dev/null", { bdReady: ready, board: emptyBoard(), auditDeps: deps });
    expect(eventsOf(rows, "BD_READY_CACHE")).toEqual([
      "BD_READY_CACHE_STALE_SERVED",
      "BD_READY_CACHE_REFRESHED",
    ]);
  });

  test("forced refresh of a fresh cache emits REFRESHED only", () => {
    const { rows, deps } = captureAudit();
    const ready = bdReadyResult();
    ready.stale = false;
    ready.refreshed = true;
    nextWork("/dev/null", { bdReady: ready, board: emptyBoard(), auditDeps: deps });
    expect(eventsOf(rows, "BD_READY_CACHE")).toEqual(["BD_READY_CACHE_REFRESHED"]);
  });

  test("emits NEXT_WORK_THREAD_RANKED once per non-empty thread", () => {
    const { rows, deps } = captureAudit();
    nextWork("/dev/null", {
      bdReady: bdReadyResult(),
      board: emptyBoard(),
      auditDeps: deps,
    });
    const ranked = rows.filter(
      (r) => r.kind === "catalog-event" && r.event === "NEXT_WORK_THREAD_RANKED",
    );
    // Mixed fixture: ready_to_start has 3 rows, blocked has 3 rows → 2 non-empty threads.
    expect(ranked).toHaveLength(2);
    const kinds = ranked.map((r) => (r.details as { kind: string }).kind);
    expect(kinds.sort()).toEqual(["blocked", "ready_to_start"]);
    const readyEntry = ranked.find(
      (r) => (r.details as { kind: string }).kind === "ready_to_start",
    );
    expect(readyEntry?.details).toMatchObject({ count: 3, top_bd_id: "ai-home-r2" });
  });

  test("emits exactly one NEXT_WORK_PROJECTED with top_thread set", () => {
    const { rows, deps } = captureAudit();
    nextWork("/dev/null", {
      bdReady: bdReadyResult(),
      board: emptyBoard(),
      auditDeps: deps,
    });
    const projected = rows.filter(
      (r) => r.kind === "catalog-event" && r.event === "NEXT_WORK_PROJECTED",
    );
    expect(projected).toHaveLength(1);
    expect(projected[0]?.details).toMatchObject({
      threads: DEFAULT_THREAD_ORDER.length,
      // Default order puts ready_to_start before blocked; fixture has no
      // orphan/pr_awaiting_ci/etc., so ready_to_start is the first non-empty.
      top_thread: "ready_to_start",
    });
  });

  test("NEXT_WORK_PROJECTED is the last catalog event in the stream", () => {
    const { rows, deps } = captureAudit();
    nextWork("/dev/null", {
      bdReady: bdReadyResult(),
      board: emptyBoard(),
      auditDeps: deps,
    });
    const catalogEvents = rows.filter((r) => r.kind === "catalog-event");
    expect((catalogEvents.at(-1) as { event: string }).event).toBe("NEXT_WORK_PROJECTED");
  });
});

describe("nextWork — per-column recommended actions", () => {
  test("projects a board with a unit in every column (exercises the next-action switch)", () => {
    const columns: BoardColumn[] = [
      "no_worktree",
      "worktree_created",
      "branch_created",
      "committing",
      "pushed",
      "pr_open",
      "ci_running",
      "review",
      "changes_requested",
      "approved",
      "merge_ready",
      "cleanup_pending",
      "merged",
      "cleaned",
    ];
    const units = columns.map((column, i) =>
      makeUnit({ branch: `GH-${100 + i}`, column, ticket: `GH-${100 + i}` }),
    );
    const result = nextWork("/dev/null", { bdReady: bdReadyResult(), board: emptyBoard(units) });
    expect(result).toBeDefined();
    expect(Array.isArray(result.threads)).toBe(true);
  });
});

describe("nextWork — prx.toml [next_work] config readers", () => {
  function repoWithConfig(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "next-work-cfg-"));
    writeFileSync(join(dir, "prx.toml"), body);
    return dir;
  }

  test("thread_order from [next_work] reorders the surface (front-loads listed kinds)", () => {
    // loadThreadOrder: listed kinds first (deduped), then the remaining
    // defaults appended so the result stays exhaustive.
    const dir = repoWithConfig(
      [
        "[next_work]",
        "# a comment, and a blank line follow",
        "",
        'thread_order = ["blocked", "blocked", "ready_to_start"]',
        "plan_paused_ttl_seconds = 4242",
      ].join("\n"),
    );
    const result = nextWork(dir, { bdReady: bdReadyResult([], []), board: emptyBoard() });
    const kinds = result.threads.map((t) => t.kind);
    expect(kinds.slice(0, 2)).toEqual(["blocked", "ready_to_start"]);
    // Exhaustive: every default kind is still present exactly once.
    expect(new Set(kinds)).toEqual(new Set(DEFAULT_THREAD_ORDER));
    expect(kinds.length).toBe(DEFAULT_THREAD_ORDER.length);
  });

  test("a non-array thread_order value is ignored → default order", () => {
    const dir = repoWithConfig('[next_work]\nthread_order = "blocked"\n');
    const result = nextWork(dir, { bdReady: bdReadyResult([], []), board: emptyBoard() });
    expect(result.threads.map((t) => t.kind)).toEqual([...DEFAULT_THREAD_ORDER]);
  });

  test("keys outside the [next_work] section are ignored", () => {
    const dir = repoWithConfig('[other]\nthread_order = ["blocked"]\n');
    const result = nextWork(dir, { bdReady: bdReadyResult([], []), board: emptyBoard() });
    expect(result.threads.map((t) => t.kind)).toEqual([...DEFAULT_THREAD_ORDER]);
  });
});

describe("nextWork — priorityLabelToNumber via stale triage rows", () => {
  // priority is intentionally widened to string (one case feeds an
  // out-of-vocab label to exercise priorityLabelToNumber's default arm).
  function staleRow(
    priority: string,
    beadsId: string,
    issueNumber: number,
  ): TriageStatusResult["stale"][number] {
    return {
      beadsId,
      issueNumber,
      url: `https://github.com/owner/repo/issues/${issueNumber}`,
      title: `stale ${priority}`,
      status: "open",
      priority,
      issueType: "task",
      reason: "gh-issue-closed",
    } as TriageStatusResult["stale"][number];
  }

  test("critical/high/low/unknown labels map to 0/1/3/3", () => {
    const triage = makeTriageSnapshot({
      stale: [
        staleRow("critical", "bd-crit", 1),
        staleRow("high", "bd-high", 2),
        staleRow("low", "bd-low", 3),
        staleRow("garbage", "bd-unk", 4),
      ],
    });
    const result = nextWork("/dev/null", {
      bdReady: bdReadyResult([], []),
      board: emptyBoard(),
      triage,
    });
    const byId = new Map(
      result.threads
        .find((t) => t.kind === "triage_backlog")!
        .candidates.map((c) => [c.bd_id, c.priority]),
    );
    expect(byId.get("bd-crit")).toBe(0);
    expect(byId.get("bd-high")).toBe(1);
    expect(byId.get("bd-low")).toBe(3);
    expect(byId.get("bd-unk")).toBe(3); // unknown label sinks to low
  });
});
