// `prx memory compact` runtime — memory-decay policy (GH-1513;
// GH-1500 ADR §7 split 4 of GH-298). Selects eligible closed work-item
// records (read from Front Desk) and classifies each candidate. One audit
// row per tick, plus an optional per-record row per classified candidate.
//
// GH-1012: the bd substrate (and the `bd admin compact --auto` write plane)
// was retired. There is no compaction backend to write to any more, so this
// verb is now classification + audit only — the durable output is the audit
// log, and `apply` vs dry-run differ only in the audit `dryRun` flag.
// Forward-compatible with the GH-1512 message-issue lifecycle via
// `--message-horizon-days` + a `messageIssueTypes` knob (no-op until GH-1512
// lands the type marker).
//
// Eligibility classifier (opt-out): a record is eligible iff ALL of
//   1. status === "closed"
//   2. ageDays > horizon (per-issueType horizon when in messageIssueTypes)
//   3. metadata.keep_compact !== false
//   4. issueType not in preservedTypes
//   5. id not pinned by any active-work edge (open record → this record via
//      a typed dep edge: parent-child, blocks, relates_to)
//
// All four "preserve" outcomes are reported separately so the audit log
// distinguishes operator-marker vs type-axis vs reference-pin opt-outs.

import { z } from "zod";

import { appendAuditRow as defaultAppendAuditRow } from "../audit/sink.ts";
import { getAuditRuntimeContext as defaultGetAuditRuntimeContext } from "@bounded-systems/audit-context";
import { repoNameWithOwner as defaultRepoNameWithOwner } from "../pr-state/github.ts";
import { parseBeadsRecords, type BeadsRecord } from "../triage/triage.ts";
import { frontDeskBeadsRaw } from "../beads/frontdesk-list.ts";

/** Front Desk read: the aggregate closed/open work-item set as `BeadsRecord[]`. */
function defaultLoadAllBeads(cwd: string): BeadsRecord[] {
  return parseBeadsRecords(frontDeskBeadsRaw(cwd));
}

// ── options + deps ─────────────────────────────────────────────────────────

export const runMemoryCompactOptionsSchema = z.object({
  /** Optional OWNER/REPO label for the audit row. Defaults to `repoNameWithOwner(cwd)`. */
  repo: z.string().optional(),
  /**
   * When true, mark the run as an apply tick (audit `dryRun: false`); when
   * false (default), a dry-run. GH-1012: with the bd write plane retired both
   * modes classify + audit only — no substrate is mutated either way.
   */
  apply: z.boolean().default(false),
  /** General closed-age threshold in days (default 90). */
  horizonDays: z.number().nonnegative().default(90),
  /**
   * Closed-age threshold for records whose `issueType` matches a configured
   * message-issue marker (GH-1512 contract; no-op until the type axis is
   * populated by that sibling split).
   */
  messageHorizonDays: z.number().nonnegative().default(14),
  /** issueType strings the message horizon applies to. Empty by default. */
  messageIssueTypes: z.array(z.string()).default([]),
  /** issueType strings that opt out of compaction entirely. Empty by default. */
  preservedTypes: z.array(z.string()).default([]),
  /** Max records to compact this tick; remainder reported as `deferred`. */
  limit: z.number().int().positive().default(100),
  format: z.enum(["plain", "json"]).default("plain"),
});
export type RunMemoryCompactOptions = z.input<typeof runMemoryCompactOptionsSchema>;

export type RunMemoryCompactDeps = {
  cwd?: () => string;
  loadAllBeads?: typeof defaultLoadAllBeads;
  repoNameWithOwner?: (path: string) => string;
  appendAuditRow?: typeof defaultAppendAuditRow;
  getAuditRuntimeContext?: typeof defaultGetAuditRuntimeContext;
  now?: () => Date;
};

// ── classifier + summary shapes ────────────────────────────────────────────

export type MemoryCompactDecision =
  | "compacted"
  | "preserved-marker"
  | "preserved-type"
  | "preserved-active-work"
  | "under-horizon"
  | "deferred";

export type MemoryCompactRecordDetail = {
  beadId: string;
  issueType: string;
  ageDays: number;
  decision: MemoryCompactDecision;
  reason?: string;
};

export type MemoryCompactSummary = {
  repo: string;
  scanned: number;
  closed: number;
  eligible: number;
  compacted: number;
  preservedByMarker: number;
  preservedByType: number;
  preservedByActiveWork: number;
  underHorizon: number;
  deferred: number;
  dryRun: boolean;
  durationMs: number;
};

export type RunMemoryCompactResult = {
  exitCode: number;
  summary: MemoryCompactSummary;
  records: MemoryCompactRecordDetail[];
};

// ── helpers ────────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function ageDays(updatedAt: string | null | undefined, now: Date): number | null {
  if (!updatedAt || typeof updatedAt !== "string") return null;
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return null;
  const delta = now.getTime() - t;
  return delta / MS_PER_DAY;
}

function hasKeepCompactFalse(record: BeadsRecord): boolean {
  if (!record.metadata) return false;
  const value = (record.metadata as Record<string, unknown>).keep_compact;
  return value === false;
}

/**
 * Collect every active-work pin: for each open record, every outgoing
 * dependency edge target. Any closed id that appears as an edge target is
 * pinned by active work and must not be compacted.
 *
 * Front Desk (GH-1012) carries the dependency edges inline on each record
 * (`record.dependencies`, populated from `fds list` edges), so this is a pure
 * pass over the already-loaded records — no separate `bd dep list` call.
 */
function loadActiveWorkPins(openRecords: BeadsRecord[]): Set<string> {
  const pins = new Set<string>();
  for (const record of openRecords) {
    for (const dep of record.dependencies ?? []) {
      if (typeof dep.dependsOnId === "string" && dep.dependsOnId.length > 0) {
        pins.add(dep.dependsOnId);
      }
    }
  }
  return pins;
}

// ── the tick ───────────────────────────────────────────────────────────────

export function runMemoryCompact(
  input: RunMemoryCompactOptions,
  output: { log: (line: string) => void; error: (line: string) => void },
  deps: RunMemoryCompactDeps = {},
): RunMemoryCompactResult {
  const opts = runMemoryCompactOptionsSchema.parse(input);
  const nowFn = deps.now ?? (() => new Date());
  const startedAt = nowFn().getTime();
  const elapsedMs = () => Math.max(0, nowFn().getTime() - startedAt);
  const cwd = (deps.cwd ?? (() => process.cwd()))();
  const loadAllBeads = deps.loadAllBeads ?? defaultLoadAllBeads;
  const repoNameWithOwner = deps.repoNameWithOwner ?? defaultRepoNameWithOwner;
  const appendAuditRow = deps.appendAuditRow ?? defaultAppendAuditRow;
  const getAuditRuntimeContext = deps.getAuditRuntimeContext ?? defaultGetAuditRuntimeContext;

  const dryRun = !opts.apply;

  let repo: string;
  try {
    repo =
      opts.repo && opts.repo.trim().length > 0 ? opts.repo.trim() : repoNameWithOwner(cwd).trim();
  } catch {
    repo = "";
  }

  // ── enumerate ────────────────────────────────────────────────────────────
  let beads: BeadsRecord[];
  try {
    beads = loadAllBeads(cwd);
  } catch (err) {
    output.error(`memory compact: ${err instanceof Error ? err.message : String(err)}`);
    return makeFailure(repo, elapsedMs(), dryRun);
  }
  const scanned = beads.length;

  const openRecords = beads.filter((b) => b.status !== "closed");
  const closedRecords = beads.filter((b) => b.status === "closed");
  const closed = closedRecords.length;

  const activeWorkPins = loadActiveWorkPins(openRecords);

  const messageTypeSet = new Set(opts.messageIssueTypes);
  const preservedTypeSet = new Set(opts.preservedTypes);
  const now = nowFn();

  // ── classify ────────────────────────────────────────────────────────────
  const records: MemoryCompactRecordDetail[] = [];
  const eligibleIds: string[] = [];
  let preservedByMarker = 0;
  let preservedByType = 0;
  let preservedByActiveWork = 0;
  let underHorizon = 0;

  for (const record of closedRecords) {
    const horizon = messageTypeSet.has(record.issueType)
      ? opts.messageHorizonDays
      : opts.horizonDays;
    const age = ageDays(record.updatedAt ?? null, now);
    const ageDaysValue = age ?? 0;

    if (hasKeepCompactFalse(record)) {
      preservedByMarker += 1;
      records.push({
        beadId: record.id,
        issueType: record.issueType,
        ageDays: ageDaysValue,
        decision: "preserved-marker",
        reason: "metadata.keep_compact === false",
      });
      continue;
    }

    if (preservedTypeSet.has(record.issueType)) {
      preservedByType += 1;
      records.push({
        beadId: record.id,
        issueType: record.issueType,
        ageDays: ageDaysValue,
        decision: "preserved-type",
        reason: `issueType '${record.issueType}' in preservedTypes`,
      });
      continue;
    }

    if (activeWorkPins.has(record.id)) {
      preservedByActiveWork += 1;
      records.push({
        beadId: record.id,
        issueType: record.issueType,
        ageDays: ageDaysValue,
        decision: "preserved-active-work",
        reason: "referenced by an open work-item record",
      });
      continue;
    }

    if (age === null || age <= horizon) {
      underHorizon += 1;
      records.push({
        beadId: record.id,
        issueType: record.issueType,
        ageDays: ageDaysValue,
        decision: "under-horizon",
        reason:
          age === null ? "no updated_at timestamp" : `age ${age.toFixed(1)}d ≤ horizon ${horizon}d`,
      });
      continue;
    }

    eligibleIds.push(record.id);
    records.push({
      beadId: record.id,
      issueType: record.issueType,
      ageDays: ageDaysValue,
      decision: "compacted",
    });
  }

  // ── limit cap → deferred ────────────────────────────────────────────────
  let deferred = 0;
  let compactIds = eligibleIds;
  if (eligibleIds.length > opts.limit) {
    compactIds = eligibleIds.slice(0, opts.limit);
    const deferredIds = new Set(eligibleIds.slice(opts.limit));
    deferred = deferredIds.size;
    for (const detail of records) {
      if (deferredIds.has(detail.beadId)) {
        detail.decision = "deferred";
        detail.reason = `--limit ${opts.limit} cap reached`;
      }
    }
  }
  const eligible = compactIds.length + deferred;
  // GH-1012: the bd `admin compact` write plane was retired and there is no
  // replacement compaction backend (GitHub is the write plane; Front Desk is
  // read-only). The classifier's `compacted` decisions and the audit rows are
  // the durable output now — nothing is written to any substrate, so `apply`
  // and dry-run produce the same count and differ only in the audit `dryRun`
  // flag.
  const compacted = compactIds.length;

  const summary: MemoryCompactSummary = {
    repo,
    scanned,
    closed,
    eligible,
    compacted,
    preservedByMarker,
    preservedByType,
    preservedByActiveWork,
    underHorizon,
    deferred,
    dryRun,
    durationMs: elapsedMs(),
  };

  // ── audit rows ──────────────────────────────────────────────────────────
  const actor = getAuditRuntimeContext().actor;
  const ts = nowFn().toISOString();
  appendAuditRow({
    ts,
    kind: "memory-compact-run" as const,
    repo: summary.repo,
    scanned: summary.scanned,
    closed: summary.closed,
    eligible: summary.eligible,
    compacted: summary.compacted,
    preservedByMarker: summary.preservedByMarker,
    preservedByType: summary.preservedByType,
    preservedByActiveWork: summary.preservedByActiveWork,
    underHorizon: summary.underHorizon,
    deferred: summary.deferred,
    dryRun: summary.dryRun,
    durationMs: summary.durationMs,
    actor,
  });
  for (const detail of records) {
    appendAuditRow({
      ts,
      kind: "memory-compact-record" as const,
      beadId: detail.beadId,
      issueType: detail.issueType,
      ageDays: detail.ageDays,
      decision: detail.decision,
      ...(detail.reason ? { reason: detail.reason } : {}),
      dryRun,
      actor,
    });
  }

  output.log(renderSummary(summary, records, opts.format));
  return { exitCode: 0, summary, records };
}

// ── rendering ──────────────────────────────────────────────────────────────

function renderSummary(
  s: MemoryCompactSummary,
  records: MemoryCompactRecordDetail[],
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify({ ...s, records }, null, 2);
  }
  const lines: string[] = [];
  lines.push(`memory compact — ${s.repo}${s.dryRun ? " [dry-run]" : ""}`);
  lines.push(
    `  scanned ${s.scanned}  closed ${s.closed}  eligible ${s.eligible}  compacted ${s.compacted}`,
  );
  lines.push(
    `  preserved: marker ${s.preservedByMarker}  type ${s.preservedByType}  active-work ${s.preservedByActiveWork}`,
  );
  lines.push(`  underHorizon ${s.underHorizon}  deferred ${s.deferred}`);
  lines.push(`  ${s.durationMs}ms`);
  return lines.join("\n");
}

function makeFailure(repo: string, durationMs: number, dryRun: boolean): RunMemoryCompactResult {
  const summary: MemoryCompactSummary = {
    repo,
    scanned: 0,
    closed: 0,
    eligible: 0,
    compacted: 0,
    preservedByMarker: 0,
    preservedByType: 0,
    preservedByActiveWork: 0,
    underHorizon: 0,
    deferred: 0,
    dryRun,
    durationMs,
  };
  return { exitCode: 1, summary, records: [] };
}
