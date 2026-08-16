// GH-1513 — `runMemoryCompact` fixture-driven coverage. Every external
// dependency is injected (the Front Desk record loader, repo resolver, audit
// sink, the clock) so the verb runs with no `gh` or disk I/O. Validates the
// eligibility classifier across every branch + the §3 frozen-mirror invariant
// (no compaction write plane; classification + audit only after GH-1012).

import { describe, expect, test } from "bun:test";

import {
  memoryCompactRunAuditSchema,
  memoryCompactRecordAuditSchema,
} from "../../src/triage/schemas/audit.ts";
import {
  runMemoryCompact,
  type RunMemoryCompactDeps,
  type RunMemoryCompactOptions,
} from "../../src/memory/compact.ts";
import type { BeadsRecord } from "../../src/triage/triage.ts";

// ── fixtures ───────────────────────────────────────────────────────────────

const FIXED_NOW = new Date("2026-05-13T12:00:00.000Z");

function isoDaysAgo(days: number): string {
  return new Date(FIXED_NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function bead(overrides: Partial<BeadsRecord> & { id: string }): BeadsRecord {
  return {
    id: overrides.id,
    title: overrides.title ?? `bead ${overrides.id}`,
    description: overrides.description ?? "",
    status: overrides.status ?? "closed",
    priority: overrides.priority ?? null,
    issueType: overrides.issueType ?? "task",
    externalRef: overrides.externalRef ?? null,
    externalRefs: overrides.externalRefs ?? {},
    metadata: overrides.metadata ?? null,
    externalIssueNumber: overrides.externalIssueNumber ?? null,
    sourceSystem: overrides.sourceSystem ?? null,
    updatedAt: overrides.updatedAt,
    ...(overrides.dependencies !== undefined ? { dependencies: overrides.dependencies } : {}),
  };
}

type Captured = {
  rows: unknown[];
  logs: string[];
  errs: string[];
};

function makeDeps(
  beads: BeadsRecord[],
  pinnedIds: Set<string> = new Set(),
  over: Partial<RunMemoryCompactDeps> = {},
): {
  deps: RunMemoryCompactDeps;
  cap: Captured;
  output: { log: (l: string) => void; error: (l: string) => void };
} {
  const cap: Captured = { rows: [], logs: [], errs: [] };
  // Express active-work pins as Front Desk dependency edges on an open record.
  // GH-1012: the active-work scan is a pure pass over `record.dependencies`
  // (populated from `fds list` edges) — there is no `bd dep list` call any more.
  if (pinnedIds.size > 0) {
    const openRecord = beads.find((b) => b.status !== "closed");
    if (openRecord) {
      openRecord.dependencies = [
        ...(openRecord.dependencies ?? []),
        ...Array.from(pinnedIds).map((id) => ({
          issueId: openRecord.id,
          dependsOnId: id,
          type: "blocks",
        })),
      ];
    }
  }
  const deps: RunMemoryCompactDeps = {
    cwd: () => "/repo",
    repoNameWithOwner: () => "bdelanghe/ai-home",
    loadAllBeads: () => beads,
    appendAuditRow: (row) => cap.rows.push(row),
    getAuditRuntimeContext: () => ({
      verb: "memory.compact",
      actor: "test-actor",
      ghTruthReason: null,
      source: null,
    }),
    now: () => FIXED_NOW,
    ...over,
  };
  return {
    deps,
    cap,
    output: { log: (l) => cap.logs.push(l), error: (l) => cap.errs.push(l) },
  };
}

function defaultOpts(over: Partial<RunMemoryCompactOptions> = {}): RunMemoryCompactOptions {
  return { format: "plain", apply: false, ...over };
}

function summaryRow(rows: unknown[]): Record<string, unknown> {
  const row = rows.find(
    (r): r is Record<string, unknown> =>
      typeof r === "object" &&
      r !== null &&
      (r as Record<string, unknown>).kind === "memory-compact-run",
  );
  expect(row).toBeDefined();
  return row as Record<string, unknown>;
}

function recordRows(rows: unknown[]): Record<string, unknown>[] {
  return rows.filter(
    (r): r is Record<string, unknown> =>
      typeof r === "object" &&
      r !== null &&
      (r as Record<string, unknown>).kind === "memory-compact-record",
  );
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("runMemoryCompact — fixture work-graph", () => {
  // Shared fixture covering every classifier branch.
  function buildFixture() {
    const beads: BeadsRecord[] = [
      // 5 open records — must never be touched.
      bead({ id: "bd-open-1", status: "open" }),
      bead({ id: "bd-open-2", status: "open" }),
      bead({ id: "bd-open-3", status: "open" }),
      bead({ id: "bd-open-4", status: "open" }),
      bead({ id: "bd-open-5", status: "open" }),
      // 5 closed older than horizon, no markers → eligible.
      bead({ id: "bd-elig-1", updatedAt: isoDaysAgo(120) }),
      bead({ id: "bd-elig-2", updatedAt: isoDaysAgo(110) }),
      bead({ id: "bd-elig-3", updatedAt: isoDaysAgo(100) }),
      bead({ id: "bd-elig-4", updatedAt: isoDaysAgo(95) }),
      bead({ id: "bd-elig-5", updatedAt: isoDaysAgo(200) }),
      // 2 closed older than horizon with keep_compact: false → preserved by marker.
      bead({
        id: "bd-mark-1",
        updatedAt: isoDaysAgo(150),
        metadata: { keep_compact: false },
      }),
      bead({
        id: "bd-mark-2",
        updatedAt: isoDaysAgo(150),
        metadata: { keep_compact: false, notes: "operator-pinned" },
      }),
      // 2 closed older than horizon whose id is pinned by an open record's dep
      // edges → preserved by active-work.
      bead({ id: "bd-pin-1", updatedAt: isoDaysAgo(180) }),
      bead({ id: "bd-pin-2", updatedAt: isoDaysAgo(180) }),
      // 3 closed younger than horizon → under-horizon.
      bead({ id: "bd-fresh-1", updatedAt: isoDaysAgo(10) }),
      bead({ id: "bd-fresh-2", updatedAt: isoDaysAgo(30) }),
      bead({ id: "bd-fresh-3", updatedAt: isoDaysAgo(60) }),
      // 2 closed message-issue records older than message-horizon → eligible.
      bead({
        id: "bd-msg-1",
        issueType: "message",
        updatedAt: isoDaysAgo(20),
      }),
      bead({
        id: "bd-msg-2",
        issueType: "message",
        updatedAt: isoDaysAgo(30),
      }),
    ];
    return { beads, pinnedIds: new Set(["bd-pin-1", "bd-pin-2"]) };
  }

  test("dry-run (default): classifier partitions records; no substrate write", () => {
    const { beads, pinnedIds } = buildFixture();
    const { deps, cap, output } = makeDeps(beads, pinnedIds);

    const result = runMemoryCompact(
      defaultOpts({
        horizonDays: 90,
        messageHorizonDays: 14,
        messageIssueTypes: ["message"],
      }),
      output,
      deps,
    );

    expect(result.exitCode).toBe(0);

    const summary = summaryRow(cap.rows);
    expect(summary.scanned).toBe(beads.length);
    expect(summary.closed).toBe(beads.length - 5);
    // 5 eligible + 2 message-issue eligible.
    expect(summary.eligible).toBe(7);
    expect(summary.compacted).toBe(7);
    expect(summary.preservedByMarker).toBe(2);
    expect(summary.preservedByActiveWork).toBe(2);
    expect(summary.underHorizon).toBe(3);
    expect(summary.preservedByType).toBe(0);
    expect(summary.deferred).toBe(0);
    expect(summary.dryRun).toBe(true);
    expect(memoryCompactRunAuditSchema.parse(summary)).toBeTruthy();

    // Per-record rows: one per closed candidate.
    const details = recordRows(cap.rows);
    expect(details.length).toBe(beads.length - 5);
    for (const detail of details) {
      expect(memoryCompactRecordAuditSchema.parse(detail)).toBeTruthy();
    }
    const compactedIds = details
      .filter((d) => d.decision === "compacted")
      .map((d) => d.beadId)
      .sort();
    expect(compactedIds).toEqual([
      "bd-elig-1",
      "bd-elig-2",
      "bd-elig-3",
      "bd-elig-4",
      "bd-elig-5",
      "bd-msg-1",
      "bd-msg-2",
    ]);
  });

  test("--apply classifies the same eligible set and records a non-dry-run tick", () => {
    const { beads, pinnedIds } = buildFixture();
    const { deps, cap, output } = makeDeps(beads, pinnedIds);

    const result = runMemoryCompact(
      defaultOpts({
        apply: true,
        horizonDays: 90,
        messageHorizonDays: 14,
        messageIssueTypes: ["message"],
      }),
      output,
      deps,
    );

    expect(result.exitCode).toBe(0);

    const summary = summaryRow(cap.rows);
    // GH-1012: apply and dry-run classify identically; only the audit `dryRun`
    // flag differs (the compaction write plane was retired).
    expect(summary.dryRun).toBe(false);
    expect(summary.compacted).toBe(7);

    const details = recordRows(cap.rows);
    const compactedIds = details
      .filter((d) => d.decision === "compacted")
      .map((d) => d.beadId)
      .sort();
    expect(compactedIds).toEqual([
      "bd-elig-1",
      "bd-elig-2",
      "bd-elig-3",
      "bd-elig-4",
      "bd-elig-5",
      "bd-msg-1",
      "bd-msg-2",
    ]);
  });

  test("preservedTypes opt-out keeps configured issueTypes verbatim", () => {
    const beads: BeadsRecord[] = [
      bead({ id: "bd-open-1", status: "open" }),
      bead({ id: "bd-task-1", issueType: "task", updatedAt: isoDaysAgo(120) }),
      bead({ id: "bd-adr-1", issueType: "adr", updatedAt: isoDaysAgo(120) }),
      bead({ id: "bd-adr-2", issueType: "adr", updatedAt: isoDaysAgo(120) }),
    ];
    const { deps, cap, output } = makeDeps(beads, new Set());
    runMemoryCompact(defaultOpts({ horizonDays: 90, preservedTypes: ["adr"] }), output, deps);
    const summary = summaryRow(cap.rows);
    expect(summary.preservedByType).toBe(2);
    expect(summary.eligible).toBe(1);
    expect(summary.compacted).toBe(1);
  });

  test("--limit caps compacted; remainder is reported as deferred", () => {
    const beads: BeadsRecord[] = [
      bead({ id: "bd-open-1", status: "open" }),
      bead({ id: "bd-a", updatedAt: isoDaysAgo(120) }),
      bead({ id: "bd-b", updatedAt: isoDaysAgo(120) }),
      bead({ id: "bd-c", updatedAt: isoDaysAgo(120) }),
      bead({ id: "bd-d", updatedAt: isoDaysAgo(120) }),
    ];
    const { deps, cap, output } = makeDeps(beads, new Set());
    runMemoryCompact(defaultOpts({ horizonDays: 90, limit: 2 }), output, deps);
    const summary = summaryRow(cap.rows);
    expect(summary.eligible).toBe(4);
    expect(summary.compacted).toBe(2);
    expect(summary.deferred).toBe(2);

    const details = recordRows(cap.rows);
    const deferredIds = details
      .filter((d) => d.decision === "deferred")
      .map((d) => d.beadId)
      .sort();
    expect(deferredIds.length).toBe(2);
  });

  test("invocation never reads the GH adapter (§3 frozen-mirror invariant)", () => {
    // The deps surface admits no gh hook; active-work pins come purely from the
    // Front Desk dependency edges on the loaded records — no substrate write.
    const { beads, pinnedIds } = buildFixture();
    const { deps, cap, output } = makeDeps(beads, pinnedIds);
    const result = runMemoryCompact(defaultOpts({ horizonDays: 90 }), output, deps);
    expect(result.exitCode).toBe(0);
    const summary = summaryRow(cap.rows);
    // The active-work scan (over record.dependencies) still pins the two
    // referenced closed records — proving the pin path with no bd call.
    expect(summary.preservedByActiveWork).toBe(2);
  });
});
