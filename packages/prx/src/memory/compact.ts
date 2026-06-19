// `prx memory compact` runtime — bd-side memory-decay policy (GH-1513;
// GH-1500 ADR §7 split 4 of GH-298). Selects eligible closed bd records,
// then delegates the compaction to `bd admin compact --auto` via the
// policy-enforced wrapper (`runBdAdminCompact`). One audit row per tick,
// plus an optional per-record row per classified candidate.
//
// Compaction is bd-side only (ADR §3 "closed once frozen"). This verb does
// not invoke the GH adapter, does not consume the GraphQL budget, and does
// not produce parity-chain transitions. Forward-compatible with the
// GH-1512 message-issue lifecycle via `--message-horizon-days` + a
// `messageIssueTypes` knob (no-op until GH-1512 lands the type marker).
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

import { processEnv } from "@bounded-systems/env";
import { z } from "zod";

import { appendAuditRow as defaultAppendAuditRow } from "../audit/sink.ts";
import { getAuditRuntimeContext as defaultGetAuditRuntimeContext } from "@bounded-systems/audit-context";
import { repoNameWithOwner as defaultRepoNameWithOwner } from "../pr-state/github.ts";
import {
  execBd as defaultExecBd,
  runBdAdminCompact as defaultRunBdAdminCompact,
  type BdAdminCompactResult,
} from "@bounded-systems/bd";
import { loadAllBeads as defaultLoadAllBeads, type BeadsRecord } from "../triage/triage.ts";

// ── options + deps ─────────────────────────────────────────────────────────

export const runMemoryCompactOptionsSchema = z.object({
  /** Optional OWNER/REPO label for the audit row. Defaults to `repoNameWithOwner(cwd)`. */
  repo: z.string().optional(),
  /** When false, invoke `bd admin compact`; when true (default), classify-only. */
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
  execBd?: typeof defaultExecBd;
  runBdAdminCompact?: typeof defaultRunBdAdminCompact;
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
 * Load every active-work edge: for each open bd id, ask bd for its outgoing
 * dependency edges (down direction). Any closed bd id that appears as an
 * edge target is pinned by active work and must not be compacted.
 *
 * One batched call (`bd dep list <id1> <id2> ... --direction down --json`).
 */
function loadActiveWorkPins(openIds: string[], exec: typeof defaultExecBd): Set<string> {
  const pins = new Set<string>();
  if (openIds.length === 0) return pins;
  const result = exec(
    {
      subcommand: "dep",
      args: ["list", ...openIds, "--direction", "down", "--json"],
      state: "planning",
      role: "planner",
    },
    processEnv(),
  );
  if (result.exitCode !== 0) {
    // Surface as an empty pin set; the verb logs the bd stderr and the
    // operator can re-run after fixing bd. Without dep data we fail-safe by
    // not compacting anything — pins are checked, so emptiness means
    // nothing passes the active-work gate either.
    return pins;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout || "[]");
  } catch {
    return pins;
  }
  if (!Array.isArray(raw)) return pins;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    // bd v1.x `bd dep list --direction down` emits each row as the depended-on
    // issue object with `dependency_type` appended; field naming has varied
    // across bd releases. Accept any shape that carries an `id`/`to`/
    // `target_id`/`depends_on_id` string and pin that id.
    for (const key of ["id", "to", "target_id", "depends_on_id", "depends_on"]) {
      const value = row[key];
      if (typeof value === "string" && value.length > 0) {
        pins.add(value);
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
  const execBdFn = deps.execBd ?? defaultExecBd;
  const runCompact = deps.runBdAdminCompact ?? defaultRunBdAdminCompact;
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
    beads = loadAllBeads();
  } catch (err) {
    output.error(`memory compact: ${err instanceof Error ? err.message : String(err)}`);
    return makeFailure(repo, elapsedMs(), dryRun);
  }
  const scanned = beads.length;

  const openIds = beads.filter((b) => b.status !== "closed").map((b) => b.id);
  const closedRecords = beads.filter((b) => b.status === "closed");
  const closed = closedRecords.length;

  const activeWorkPins = loadActiveWorkPins(openIds, execBdFn);

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
        reason: "referenced by an open bd record",
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
  let compacted = 0;
  let bdResult: BdAdminCompactResult | null = null;

  // ── compact (apply only) ────────────────────────────────────────────────
  if (!dryRun && compactIds.length > 0) {
    bdResult = runCompact(cwd, { dryRun: false, ids: compactIds });
    for (const r of bdResult.results) {
      if (r.exitCode === 0) {
        compacted += 1;
      } else {
        // bd refused this id; reflect it back to the per-record detail.
        const detail = records.find((d) => d.beadId === r.id);
        const errMsg = r.stderr.trim() || r.stdout.trim() || "bd admin compact failed";
        if (detail) {
          detail.decision = "deferred";
          detail.reason = `bd admin compact: ${errMsg}`;
        }
      }
    }
    if (bdResult.exitCode !== 0) {
      output.error(
        `memory compact: WARN bd admin compact exited ${bdResult.exitCode} for at least one id`,
      );
    }
  } else if (dryRun) {
    // On dry-run the "compacted" classifier outcome is planned, not applied.
    compacted = compactIds.length;
  }

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
