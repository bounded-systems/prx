// GH-1537 — `domainSyncAuditSchema` round-trips through `appendAuditRow`
// (the runtime sink boundary). Mirrors test/audit/sink.test.ts's capture seam.

import { describe, expect, test } from "bun:test";

import { appendAuditRow, type AuditSinkDeps } from "../../src/audit/sink.ts";
import {
  domainSyncAuditSchema,
  domainSyncBackfillRecordAuditSchema,
  domainSyncBackfillRunAuditSchema,
  domainSyncPairAuditSchema,
  domainSyncRunAuditSchema,
} from "../../src/triage/schemas/audit.ts";

const RUN_ROW = {
  ts: "2026-05-12T09:00:00.000Z",
  kind: "domain-sync-run" as const,
  repo: "bdelanghe/ai-home",
  domain: "gh",
  scanned: 120,
  pinned: 80,
  skipped: 40,
  pulled: 80,
  pushed: 80,
  closedByPull: 3,
  failed: 1,
  pullFailed: 0,
  pullDeferred: 0,
  pushDeferred: 0,
  deferred: 0,
  budgetPaused: false,
  dryRun: false,
  durationMs: 4210,
  actor: "claude-code",
};

const PAIR_ROW = {
  ts: "2026-05-12T09:00:01.000Z",
  kind: "domain-sync-pair" as const,
  // GH-1662: per-pair rows now carry the OWNER/REPO they were reconciled
  // against (matches the summary row's `repo`).
  repo: "bdelanghe/ai-home",
  domain: "gh",
  beadId: "bd-204",
  externalId: "https://github.com/bdelanghe/ai-home/issues/204",
  externalStatus: "closed",
  closedByPull: true,
  pushed: true,
  action: "synced" as const,
  dryRun: false,
  actor: "claude-code",
};

function makeCapture() {
  const writes: Array<{ path: string; line: string }> = [];
  const deps: AuditSinkDeps = {
    appendFn: (path, line) => writes.push({ path, line }),
    ensureDir: () => {},
    stdoutFn: () => {},
    env: {} as NodeJS.ProcessEnv,
    stateDirOverride: "/tmp/state",
    now: () => new Date("2026-05-12T09:00:00.000Z"),
  };
  return { writes, deps };
}

describe("domainSyncAuditSchema", () => {
  test("the run-summary row parses both directly and via the union", () => {
    expect(domainSyncRunAuditSchema.parse(RUN_ROW)).toEqual(RUN_ROW);
    expect(domainSyncAuditSchema.parse(RUN_ROW)).toEqual(RUN_ROW);
  });

  test("the per-pair row parses (with and without an optional message)", () => {
    expect(domainSyncPairAuditSchema.parse(PAIR_ROW)).toEqual(PAIR_ROW);
    const failed = { ...PAIR_ROW, action: "failed" as const, pushed: false, closedByPull: false, message: "gh issue view failed" };
    expect(domainSyncPairAuditSchema.parse(failed)).toEqual(failed);
  });

  test("appendAuditRow accepts a domain-sync-run row", () => {
    const cap = makeCapture();
    appendAuditRow(RUN_ROW, cap.deps);
    expect(cap.writes).toHaveLength(1);
    expect(cap.writes[0]!.path).toBe("/tmp/state/prx/audit/2026-05-12.ndjson");
    const parsed = JSON.parse(cap.writes[0]!.line.trimEnd());
    expect(parsed.kind).toBe("domain-sync-run");
    expect(parsed.closedByPull).toBe(3);
  });

  test("appendAuditRow accepts a domain-sync-pair row", () => {
    const cap = makeCapture();
    appendAuditRow(PAIR_ROW, cap.deps);
    expect(cap.writes).toHaveLength(1);
    const parsed = JSON.parse(cap.writes[0]!.line.trimEnd());
    expect(parsed.kind).toBe("domain-sync-pair");
    expect(parsed.beadId).toBe("bd-204");
  });

  test("appendAuditRow rejects a malformed domain-sync-run row", () => {
    const cap = makeCapture();
    expect(() =>
      appendAuditRow({ ...RUN_ROW, scanned: -1 }, cap.deps),
    ).toThrow();
    expect(cap.writes).toHaveLength(0);
  });
});

// GH-1469 — `prx sync backfill` rows. Every row carries `uow_id` (I-BF6).
const BACKFILL_RUN_ROW = {
  ts: "2026-05-20T09:00:00.000Z",
  kind: "domain-sync-backfill-run" as const,
  repo: "bdelanghe/ai-home",
  domain: "gh",
  from: 1259,
  to: 1466,
  scanned: 3,
  mirrored: 2,
  skipped: 1,
  failed: 0,
  deferred: 0,
  budgetPaused: false,
  dryRun: false,
  durationMs: 1200,
  uow_id: "backfill:gh:1259-1466",
  actor: "claude-code",
};

const BACKFILL_RECORD_ROW = {
  ts: "2026-05-20T09:00:01.000Z",
  kind: "domain-sync-backfill-record" as const,
  repo: "bdelanghe/ai-home",
  domain: "gh",
  externalId: "https://github.com/bdelanghe/ai-home/issues/1403",
  surfaceId: "GH-1403",
  action: "mirrored" as const,
  bdId: "ai-home-new-1403",
  dryRun: false,
  uow_id: "GH-1403",
  actor: "claude-code",
};

describe("domainSyncBackfill audit rows (GH-1469)", () => {
  test("the run-summary row parses both directly and via the union", () => {
    expect(domainSyncBackfillRunAuditSchema.parse(BACKFILL_RUN_ROW)).toEqual(BACKFILL_RUN_ROW);
    expect(domainSyncAuditSchema.parse(BACKFILL_RUN_ROW)).toEqual(BACKFILL_RUN_ROW);
  });

  test("the per-record row parses (mirrored / skipped / failed actions)", () => {
    expect(domainSyncBackfillRecordAuditSchema.parse(BACKFILL_RECORD_ROW)).toEqual(BACKFILL_RECORD_ROW);
    const skipped = { ...BACKFILL_RECORD_ROW, action: "skipped" as const, bdId: "ai-home-a" };
    expect(domainSyncBackfillRecordAuditSchema.parse(skipped)).toEqual(skipped);
    const failed = { ...BACKFILL_RECORD_ROW, action: "failed" as const, bdId: undefined, message: "mirror failed" };
    const parsed = domainSyncBackfillRecordAuditSchema.parse(failed);
    expect(parsed.action).toBe("failed");
    expect(parsed.message).toBe("mirror failed");
  });

  test("appendAuditRow accepts both backfill rows", () => {
    const cap = makeCapture();
    appendAuditRow(BACKFILL_RUN_ROW, cap.deps);
    appendAuditRow(BACKFILL_RECORD_ROW, cap.deps);
    expect(cap.writes).toHaveLength(2);
    expect(JSON.parse(cap.writes[0]!.line.trimEnd()).uow_id).toBe("backfill:gh:1259-1466");
    expect(JSON.parse(cap.writes[1]!.line.trimEnd()).uow_id).toBe("GH-1403");
  });

  test("appendAuditRow rejects a backfill row missing uow_id (I-BF6)", () => {
    const cap = makeCapture();
    const { uow_id: _omit, ...noUow } = BACKFILL_RUN_ROW;
    expect(() => appendAuditRow(noUow as typeof BACKFILL_RUN_ROW, cap.deps)).toThrow();
    expect(cap.writes).toHaveLength(0);
  });
});
