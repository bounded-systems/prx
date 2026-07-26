// GH-1469 — `runBackfill` coverage. Every external dependency is injected
// (the `DomainAdapter`, `runIntakeMirror`, the budget probe, the bd loader,
// the audit sink, the clock) so the loop runs with no `gh` / `bd` / disk I/O.
// Each test is tied to an invariant (I-BF1..I-BF5); I-BF6 (uow_id on every
// event) is asserted via the audit rows.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { GhDomainAdapter } from "../../src/adapters/github.ts";
import type { AdapterCommandRunner } from "../../src/adapters/domain-adapter.ts";
import { parseCommand, runCli } from "../../src/pr-state/cli.ts";
import {
  runBackfill,
  type RunBackfillDeps,
  type RunBackfillOptions,
  type BackfillResult,
} from "../../src/sync/backfill.ts";
import type { BudgetSnapshot } from "@bounded-systems/github-budget";
import type { BeadsRecord } from "../../src/triage/triage.ts";

// GH-1012: intake-mirror (the bd write-plane) is removed. `runIntakeMirror` is
// now a local stub in backfill.ts whose opts have this shape; the mirror-call
// captures assert against `ghId`/`dryRun` off it.
type IntakeMirrorOptions = {
  ghId: string;
  repo?: string | undefined;
  dryRun: boolean;
  format: string;
};

const FIXED_NOW = new Date("2026-05-20T09:00:00.000Z");

// ── fixtures ───────────────────────────────────────────────────────────────

function pinned(id: string, n: number): BeadsRecord {
  const url = `https://github.com/o/r/issues/${n}`;
  return {
    id,
    title: `bead ${id}`,
    description: "body",
    status: "open",
    priority: 2,
    issueType: "task",
    externalRef: url,
    externalRefs: { gh: url },
    metadata: null,
    externalIssueNumber: n,
    sourceSystem: null,
  };
}

/** A bd record whose *id* contains a number-like substring but which is NOT
 * pinned to any GH issue — fuel for the I-BF1 "resolve via map, not prefix"
 * assertion. */
function unpinnedLongId(id: string): BeadsRecord {
  return {
    id,
    title: `orphan ${id}`,
    description: "body",
    status: "open",
    priority: 2,
    issueType: "task",
    externalRef: null,
    externalRefs: {},
    metadata: null,
    externalIssueNumber: null,
    sourceSystem: null,
  };
}

function listRunner(
  issues: Array<{ number: number; url: string; state: string }>,
): AdapterCommandRunner {
  return (cmd) => {
    if (cmd[1] === "issue" && cmd[2] === "list") {
      return { stdout: JSON.stringify(issues), stderr: "", status: 0 };
    }
    return { stdout: "[]", stderr: "", status: 0 };
  };
}

function ghAdapter(issues: Array<{ number: number; url: string; state: string }>): GhDomainAdapter {
  return new GhDomainAdapter({
    runner: listRunner(issues),
    repoNameWithOwner: () => "o/r",
    cwd: () => "/repo",
  });
}

function snapshot(remaining: number): BudgetSnapshot[] {
  return [{ bucket: "graphql", limit: 5000, remaining, resetAt: 0, fetchedAt: 0 }];
}

type Captured = { log: string[]; error: string[] };

function captureOutput(): {
  output: { log: (l: string) => void; error: (l: string) => void };
} & Captured {
  const log: string[] = [];
  const error: string[] = [];
  return { log, error, output: { log: (l) => log.push(l), error: (l) => error.push(l) } };
}

type MirrorCall = IntakeMirrorOptions;

function baseDeps(over: Partial<RunBackfillDeps> = {}): {
  deps: RunBackfillDeps;
  auditRows: Array<Record<string, unknown>>;
  mirrorCalls: MirrorCall[];
} {
  const auditRows: Array<Record<string, unknown>> = [];
  const mirrorCalls: MirrorCall[] = [];
  const deps: RunBackfillDeps = {
    now: () => FIXED_NOW,
    refreshBudget: () => snapshot(1000),
    repoNameWithOwner: () => "o/r",
    appendAuditRow: (row) => {
      auditRows.push(row as unknown as Record<string, unknown>);
    },
    getAuditRuntimeContext: () => ({
      verb: "sync backfill",
      actor: "test-actor",
      ghTruthReason: null,
      source: null,
    }),
    // Default mirror: a clean create that logs the JSON render backfill parses.
    runIntakeMirror: (opts, output) => {
      mirrorCalls.push(opts);
      const m = opts.ghId.match(/(\d+)/);
      const ghNumber = m ? Number.parseInt(m[1]!, 10) : 0;
      output.log(
        JSON.stringify({
          ghNumber,
          repo: opts.repo,
          issueUrl: `https://github.com/o/r/issues/${ghNumber}`,
          title: `issue ${ghNumber}`,
          createdBdId: opts.dryRun ? undefined : `ai-home-new-${ghNumber}`,
          dryRun: opts.dryRun,
          exitCode: 0,
        }),
      );
      return 0;
    },
    ...over,
  };
  return { deps, auditRows, mirrorCalls };
}

function opts(over: Partial<RunBackfillOptions> = {}): RunBackfillOptions {
  return { domain: "gh", from: 1259, to: 1466, dryRun: false, format: "json", ...over };
}

// ── I-BF2: idempotent matched-skip / unmatched-mirror / re-run zero-net ──────

describe("runBackfill — I-BF2 idempotency", () => {
  test("matched records skip, unmatched records mirror", async () => {
    const beads = [pinned("ai-home-a", 1259)]; // 1259 already mirrored
    const adapter = ghAdapter([
      { number: 1259, url: "https://github.com/o/r/issues/1259", state: "OPEN" },
      { number: 1403, url: "https://github.com/o/r/issues/1403", state: "CLOSED" },
      { number: 1466, url: "https://github.com/o/r/issues/1466", state: "OPEN" },
    ]);
    const { deps, mirrorCalls } = baseDeps({ adapter, loadAllBeads: () => beads });
    const cap = captureOutput();

    const result = await runBackfill(opts(), cap.output, deps);

    expect(result.exitCode).toBe(0);
    expect(result.summary.scanned).toBe(3);
    expect(result.summary.skipped).toBe(1); // 1259 resolved
    expect(result.summary.mirrored).toBe(2); // 1403, 1466 unmatched
    expect(result.summary.failed).toBe(0);
    // Only the two unmatched records hit the canonical mirror path.
    expect(mirrorCalls.map((c) => c.ghId).sort()).toEqual(["GH-1403", "GH-1466"]);
  });

  test("re-running over the same range after a mirror produces zero net new records", async () => {
    const beads = [pinned("ai-home-a", 1259)];
    const issues = [
      { number: 1259, url: "https://github.com/o/r/issues/1259", state: "OPEN" },
      { number: 1403, url: "https://github.com/o/r/issues/1403", state: "CLOSED" },
    ];
    const adapter = ghAdapter(issues);
    const { deps, mirrorCalls } = baseDeps({ adapter, loadAllBeads: () => beads });

    const first = await runBackfill(opts({ to: 1403 }), captureOutput().output, deps);
    expect(first.summary.mirrored).toBe(1);

    // Simulate the create: 1403 is now pinned in bd (what `runIntakeMirror`
    // would have written). The second run must skip everything.
    beads.push(pinned("ai-home-new-1403", 1403));
    mirrorCalls.length = 0;

    const second = await runBackfill(opts({ to: 1403 }), captureOutput().output, deps);
    expect(second.summary.mirrored).toBe(0);
    expect(second.summary.skipped).toBe(2);
    expect(mirrorCalls).toHaveLength(0);
  });
});

// ── I-BF1: resolve via the (domain, external_id) map, never short-id prefix ──

describe("runBackfill — I-BF1 resolve-via-map", () => {
  test("a long-id whose id merely contains the issue number does NOT match (mirrored, not skipped)", async () => {
    // This bd record's id substring-matches "1259" but it is pinned to no GH
    // issue. Prefix/substring matching would wrongly skip GH-1259; the map
    // (URL + externalIssueNumber) correctly reports it unmatched → mirror.
    const beads = [unpinnedLongId("ai-home-bd-1748-1259-3-abcd1234")];
    const adapter = ghAdapter([
      { number: 1259, url: "https://github.com/o/r/issues/1259", state: "OPEN" },
    ]);
    const { deps, mirrorCalls } = baseDeps({ adapter, loadAllBeads: () => beads });

    const result = await runBackfill(opts({ to: 1259 }), captureOutput().output, deps);

    expect(result.summary.skipped).toBe(0);
    expect(result.summary.mirrored).toBe(1);
    expect(mirrorCalls.map((c) => c.ghId)).toEqual(["GH-1259"]);
  });
});

// ── I-BF4: --dry-run performs zero bd/gh writes ──────────────────────────────

describe("runBackfill — I-BF4 dry-run no-writes", () => {
  test("--dry-run propagates dryRun to every mirror call and writes nothing", async () => {
    const beads: BeadsRecord[] = [];
    const adapter = ghAdapter([
      { number: 1403, url: "https://github.com/o/r/issues/1403", state: "OPEN" },
      { number: 1466, url: "https://github.com/o/r/issues/1466", state: "OPEN" },
    ]);
    const { deps, mirrorCalls, auditRows } = baseDeps({ adapter, loadAllBeads: () => beads });

    const result = await runBackfill(opts({ dryRun: true }), captureOutput().output, deps);

    expect(result.summary.dryRun).toBe(true);
    expect(result.summary.mirrored).toBe(2);
    // The single write seam (`runIntakeMirror`) is always told dryRun=true.
    expect(mirrorCalls.length).toBe(2);
    expect(mirrorCalls.every((c) => c.dryRun === true)).toBe(true);
    // Audit rows reflect the dry-run.
    expect(auditRows.every((r) => r.dryRun === true)).toBe(true);
  });
});

// ── I-BF5: budget gate — entry pause + mid-loop defer ────────────────────────

describe("runBackfill — I-BF5 budget gate", () => {
  test("entry budget below threshold pauses with zero scans", async () => {
    const adapter = ghAdapter([
      { number: 1, url: "https://github.com/o/r/issues/1", state: "OPEN" },
    ]);
    const { deps, mirrorCalls } = baseDeps({
      adapter,
      loadAllBeads: () => [],
      refreshBudget: () => snapshot(10), // < default threshold 100
    });

    const result = await runBackfill(opts({ from: 1, to: 1 }), captureOutput().output, deps);

    expect(result.summary.budgetPaused).toBe(true);
    expect(result.summary.scanned).toBe(0);
    expect(result.exitCode).toBe(0);
    expect(mirrorCalls).toHaveLength(0);
  });

  test("mid-loop budget drop defers the remaining records (exit 2)", async () => {
    const beads: BeadsRecord[] = [];
    const adapter = ghAdapter([
      { number: 1259, url: "https://github.com/o/r/issues/1259", state: "OPEN" },
      { number: 1403, url: "https://github.com/o/r/issues/1403", state: "OPEN" },
      { number: 1466, url: "https://github.com/o/r/issues/1466", state: "OPEN" },
    ]);
    // entry (call 1) high; before ref[1] (call 2) low → cut the rest.
    let calls = 0;
    const { deps, mirrorCalls } = baseDeps({
      adapter,
      loadAllBeads: () => beads,
      refreshBudget: () => {
        calls += 1;
        return snapshot(calls <= 1 ? 1000 : 10);
      },
    });

    const cap = captureOutput();
    const result = await runBackfill(opts(), cap.output, deps);

    expect(result.summary.mirrored).toBe(1); // only ref[0] before the cut
    expect(result.summary.deferred).toBe(2);
    expect(result.summary.budgetPaused).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(mirrorCalls).toHaveLength(1);
    expect(cap.error.join("\n")).toContain("not reached this run");
  });
});

// ── I-BF6: every backfill audit row carries uow_id ───────────────────────────

describe("runBackfill — I-BF6 audit uow_id", () => {
  test("run + record rows carry uow_id", async () => {
    const beads = [pinned("ai-home-a", 1259)];
    const adapter = ghAdapter([
      { number: 1259, url: "https://github.com/o/r/issues/1259", state: "OPEN" },
      { number: 1403, url: "https://github.com/o/r/issues/1403", state: "OPEN" },
    ]);
    const { deps, auditRows } = baseDeps({ adapter, loadAllBeads: () => beads });

    await runBackfill(opts({ to: 1403 }), captureOutput().output, deps);

    expect(auditRows.length).toBeGreaterThan(0);
    expect(
      auditRows.every((r) => typeof r.uow_id === "string" && (r.uow_id as string).length > 0),
    ).toBe(true);
    const runRow = auditRows.find((r) => r.kind === "domain-sync-backfill-run");
    expect(runRow?.uow_id).toBe("backfill:gh:1259-1403");
    const recordRow = auditRows.find(
      (r) => r.kind === "domain-sync-backfill-record" && r.surfaceId === "GH-1403",
    );
    expect(recordRow?.uow_id).toBe("GH-1403");
  });
});

// ── CLI wiring: parse + dispatch ─────────────────────────────────────────────

describe("prx sync backfill — CLI wiring", () => {
  test("parses --domain/--from/--to/--budget/--dry-run/--format", () => {
    const parsed = parseCommand([
      "sync",
      "backfill",
      "--from",
      "1259",
      "--to",
      "1466",
      "--budget",
      "250",
      "--dry-run",
      "--format",
      "json",
    ]);
    expect(parsed).toMatchObject({
      command: "sync-backfill",
      domain: "gh",
      from: 1259,
      to: 1466,
      budget: 250,
      dryRun: true,
      format: "json",
    });
  });

  test("rejects a missing --from", () => {
    expect(() => parseCommand(["sync", "backfill", "--to", "10"])).toThrow(/--from/);
  });

  test("rejects --from > --to", () => {
    expect(() => parseCommand(["sync", "backfill", "--from", "10", "--to", "1"])).toThrow(
      /must be <=/,
    );
  });

  test("dispatches to the injected backfill runtime with the parsed opts", async () => {
    let seen: RunBackfillOptions | null = null;
    const fake = (o: RunBackfillOptions): Promise<BackfillResult> => {
      seen = o;
      return Promise.resolve({
        exitCode: 0,
        summary: {
          repo: "o/r",
          domain: "gh",
          from: 1259,
          to: 1466,
          scanned: 0,
          mirrored: 0,
          skipped: 0,
          failed: 0,
          deferred: 0,
          budgetPaused: false,
          dryRun: true,
          durationMs: 0,
        },
        records: [],
      });
    };
    const exit = await runCli(
      ["sync", "backfill", "--from", "1259", "--to", "1466", "--dry-run"],
      { log: () => {}, error: () => {} },
      { backfill: fake as unknown as typeof runBackfill },
    );
    expect(exit).toBe(0);
    expect(seen!).toMatchObject({ domain: "gh", from: 1259, to: 1466, dryRun: true });
  });
});

// ── I-BF3: never advances the fetch watermark / sync cursor ──────────────────

describe("runBackfill — I-BF3 no cursor advance", () => {
  test("the runtime never imports or writes the fetch watermark", () => {
    // Structural guard: backfill heals records the watermark already passed
    // and must never touch it. The runtime has no watermark dependency.
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "src", "sync", "backfill.ts"),
      "utf8",
    );
    expect(src).not.toContain("fetch/watermark");
    expect(src).not.toContain("setWatermark");
    expect(src).not.toContain("WATERMARK_KEY");
  });
});
