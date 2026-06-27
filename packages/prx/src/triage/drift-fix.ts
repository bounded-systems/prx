// `prx triage drift-fix` (GH-1049, GH-1115) — reconcile bd↔GH field drift on
// the type / priority / status axes. Idempotent, three invocation shapes:
//
//   Phase 1 (scan):    `prx triage drift-fix [--axes ...]`
//                      — emit JSON plan to stdout (read-only).
//   Phase 2 (replay):  `prx triage drift-fix --from p.json [--dry-run] [--limit N]
//                                            [--axes type,priority,status]`
//                      — walk a previously-emitted plan.
//   One-shot:          `prx triage drift-fix --apply [--dry-run] [--limit N]
//                                            [--axes ...]`
//                      — scan and apply in a single invocation. Mutually
//                      exclusive with `--from`.
//
// Direction is GH→bd only. GitHub is authoritative for beads in ai-home (see
// memory `feedback_beads_github_authority`), so this verb writes the bd
// `issue_type` / `priority` columns (and bd open/closed status) from the GH
// labels and state, never the reverse.
//
// Decision rules (in selectDriftFixDecision()):
//   - `skip:axis-filtered`  — drift exists but only at axes excluded via --axes.
//   - `skip:no-bd-type`     — GH type is in `typeLabelSchema` (TYPE) but not in
//                             bd's narrower `BD_TYPE_ENUM` (e.g. `spike`). Hard
//                             skip; the row is left alone even if priority/
//                             status would otherwise be fixable. Operator can
//                             re-run with `--axes priority,status` to fix the
//                             other axes independently. Since GH-1532
//                             `findDrift` resolves the GH-1489 `type::spike`
//                             marker to bd's `task` before comparing, a
//                             spike-only issue no longer reaches this branch —
//                             it's now a defensive guard for hand-crafted
//                             plans loaded via `--from`.
//   - `skip:no-pair`        — GH-1783: GH-side label fails the Zod vocab
//                             schema (e.g. legacy `priority::P1`, `priority::
//                             p0`, `priority::minor`, or `type::decision`).
//                             Two different gates — raw nullable inclusion vs.
//                             Zod-validated carriage — used to disagree here,
//                             producing `decision=fix` with `axesFixed`
//                             including the axis but no carried pair; the
//                             apply phase then rejected the row as an error.
//                             Now hard-skipped so a writes/skips/errors
//                             summary cleanly distinguishes "had nothing to
//                             write" from "tried to write and failed".
//   - `skip:no-axis-drift`  — findDrift() flagged title only; out of scope.
//   - `fix`                 — at least one in-scope axis drifts. Carries
//                             `axesFixed: ("type" | "priority" | "status")[]`.
//
// Status semantics: findDrift only detects bd=closed / gh=open (it iterates
// open GH issues and checks bd status). The inverse direction (bd=open /
// gh=closed) is intentionally out of scope — it would require a separate fetch
// of recently-closed GH issues.
//
// Apply behavior (Phase 2 / one-shot): for each `fix` row,
//   1. If axesFixed includes type or priority → one
//      `bd update <bdId> [--type <gh-type>] [-p <gh-priority>]` exec.
//   2. If axesFixed includes status → one `bd reopen <bdId>` exec.
//   3. Defensive idempotency: re-load beads at apply time and short-circuit
//      rows where bd already matches GH for *every* in-scope axis.
//   4. `--dry-run` writes audit entries with `dryRun: true` and skips writes.
//   5. After all rows processed (writes > 0, not dry-run, --no-sync not set),
//      run `prx sync issues --from gh --to bd` as a smoke check.
//
// JSONL audit log: ~/.cache/prx/triage/drift-fix-<ISO>.jsonl, one row per
// processed entry plus an optional sync row at the end.

import { readFileSync as defaultReadFileSync } from "node:fs";

import { z } from "zod";

import { appendAuditRow, auditSinkPath, type AuditSinkDeps } from "../audit/sink.ts";

import { BD_TYPE_ENUM } from "./labels.ts";
import {
  priorityLabelSchema,
  typeLabelSchema,
  type PriorityLabel,
  type TypeLabel,
} from "./label-vocab.ts";
import {
  findDrift,
  loadAllBeads,
  priorityToBdNumber,
  type BeadsRecord,
  type DriftRow,
} from "./triage.ts";
import { execBd as defaultExecBd } from "@bounded-systems/bd";
import { updateBeadViaDaemon, reopenBeadViaDaemon } from "../beadsd/writes.ts";
import {
  emptyBdDoctorReport,
  runBdDoctorFix as defaultRunBdDoctorFix,
  runBdDoctorJson as defaultRunBdDoctorJson,
  runBdDuplicatesDryRun as defaultRunBdDuplicatesDryRun,
  runBdMerge as defaultRunBdMerge,
  type BdDoctorReport,
  type BdDoctorResult,
  type BdDuplicatesCluster,
  type BdDuplicatesDryRunResult,
  type BdMergeOptions,
  type BdMergeResult,
} from "@bounded-systems/bd";
import { runBeadsSync as defaultRunBeadsSync, type BeadsSyncResult } from "../sync/run.ts";
import { DEFAULT_SYNC_LIMIT } from "../sync/limits.ts";
import {
  repoNameWithOwner as defaultRepoNameWithOwner,
  type FallbackIssue,
} from "../pr-state/github.ts";
// GH-1602: substitute the gh-side `listOpenIssues` with the bd-resident
// projection. `pruneMergedActor` syncs bd from GH at the head of every triage
// pass; drift-fix is stubbed today (GH-1049) but the wiring is correct so
// unstubbing is a no-op on this surface.
import { listOpenIssuesFromBeads as defaultListOpenIssues } from "./issues-from-beads.ts";

export const driftFixAxisSchema = z.enum(["type", "priority", "status"]);
export type DriftFixAxis = z.infer<typeof driftFixAxisSchema>;

export const triageDriftFixOptionsSchema = z.object({
  repo: z.string().trim().min(1).optional(),
  from: z.string().trim().min(1).optional(),
  apply: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  limit: z.number().int().min(0).default(0),
  axes: z.array(driftFixAxisSchema).default(["type", "priority", "status"]),
  sync: z.boolean().default(true),
  // GH-1255: bd-substrate dedupe + health surfaces inside the drift-fix pass.
  // Defaults bake the in-flow behavior — the machine actor leaves them on
  // (and `applyDupes` on) while `doctorFix` stays opt-in via an explicit
  // CLI/operator flag. `--no-dupes` / `--no-doctor` / `--no-apply-dupes` are
  // the negative CLI shapes (lifted to commander in a follow-up).
  includeDupes: z.boolean().default(true),
  includeDoctor: z.boolean().default(true),
  doctorFix: z.boolean().default(false),
  applyDupes: z.boolean().default(true),
});

export type TriageDriftFixOptions = z.infer<typeof triageDriftFixOptionsSchema>;

export const driftFixDecisionSchema = z.enum([
  "fix",
  // GH-1255: bd substrate dupe-cluster merge proposal. One row per
  // (target, source) pair surfaced by `bd duplicates --dry-run`. The row
  // carries a `dupe` carrier with parity metadata rather than the axis pairs.
  "fix:dupe",
  "skip:no-bd-type",
  "skip:no-pair",
  "skip:axis-filtered",
  "skip:no-axis-drift",
]);

export type DriftFixDecision = z.infer<typeof driftFixDecisionSchema>;

// Type drift carries the raw GH label value (validated against the broader
// `typeLabelSchema` so an out-of-vocab type flows into a `skip:no-bd-type`
// decision — `spike` is excluded by `findDrift`'s GH-1532 resolver, but the
// schema still accepts it as a defensive guard) and the bd column value (free
// string — bd may hold legacy or empty values).
const driftTypePairSchema = z.object({
  gh: typeLabelSchema,
  bd: z.string(),
});

const driftPriorityPairSchema = z.object({
  gh: priorityLabelSchema,
  bd: z.string(),
});

// Status drift is one direction only: bd closed, gh open. findDrift never
// produces the inverse; pinning the literals makes that contract explicit.
const driftStatusPairSchema = z.object({
  gh: z.literal("open"),
  bd: z.literal("closed"),
});

// GH-1255: per-row carrier for a `fix:dupe` merge proposal. Target / source
// are bd IDs (both members of one `bd duplicates --dry-run` cluster pair).
// `parityOk` gates auto-merge; `parityReason` documents the mismatch when
// false (or null when parity holds).
export const driftFixDupePairSchema = z.object({
  target: z.string().min(1),
  source: z.string().min(1),
  parityOk: z.boolean(),
  parityReason: z.string().nullable(),
});
export type DriftFixDupePair = z.infer<typeof driftFixDupePairSchema>;

export const driftFixPlanRowSchema = z
  .object({
    // 0 is admitted as a "no GH twin" sentinel for `fix:dupe` rows whose
    // bd source/target isn't paired to a GH issue (the parity check still
    // runs on the cluster's bd-side priority). Non-dupe rows continue to
    // require a positive GH issue number — enforced by the superRefine.
    issueNumber: z.number().int().nonnegative(),
    beadsId: z.string().min(1),
    decision: driftFixDecisionSchema,
    reason: z.string(),
    // Present iff decision === "fix"; non-empty when present.
    axesFixed: z.array(driftFixAxisSchema).optional(),
    type: driftTypePairSchema.optional(),
    priority: driftPriorityPairSchema.optional(),
    status: driftStatusPairSchema.optional(),
    // GH-1255: present iff decision === "fix:dupe".
    dupe: driftFixDupePairSchema.optional(),
  })
  .superRefine((row, ctx) => {
    if (row.decision === "fix") {
      if (row.issueNumber <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "decision=fix requires a positive GH issue number",
          path: ["issueNumber"],
        });
      }
      if (row.dupe !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "dupe carrier only allowed when decision=fix:dupe",
          path: ["dupe"],
        });
      }
      if (!row.axesFixed || row.axesFixed.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "decision=fix requires non-empty axesFixed",
          path: ["axesFixed"],
        });
      }
      // GH-1783: every axis in axesFixed must have its pair carried so the
      // apply phase never sees `axesFixed includes X but row has no X pair`.
      // Closes the loop between the planner's gate and the apply guard.
      if (row.axesFixed?.includes("type") && !row.type) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "axesFixed includes type but row has no type pair",
          path: ["type"],
        });
      }
      if (row.axesFixed?.includes("priority") && !row.priority) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "axesFixed includes priority but row has no priority pair",
          path: ["priority"],
        });
      }
      if (row.axesFixed?.includes("status") && !row.status) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "axesFixed includes status but row has no status pair",
          path: ["status"],
        });
      }
    } else if (row.decision === "fix:dupe") {
      if (!row.dupe) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "decision=fix:dupe requires a dupe carrier",
          path: ["dupe"],
        });
      }
      if (row.axesFixed !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "axesFixed only allowed when decision=fix",
          path: ["axesFixed"],
        });
      }
    } else {
      if (row.issueNumber <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "non-fix rows require a positive GH issue number",
          path: ["issueNumber"],
        });
      }
      if (row.axesFixed !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "axesFixed only allowed when decision=fix",
          path: ["axesFixed"],
        });
      }
      if (row.dupe !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "dupe carrier only allowed when decision=fix:dupe",
          path: ["dupe"],
        });
      }
    }
  });

export type DriftFixPlanRow = z.infer<typeof driftFixPlanRowSchema>;

// bd's `duplicates`/`doctor` runtime shapes. @bounded-systems/bd@0.3.0 made its
// public API type-only (schema-gen → generated fast-types; the zod schemas are
// internal and no longer exported). The drift-fix plan still serializes these
// surfaces, so prx owns the runtime schema for its OWN plan contract here,
// mirroring bd's shape. `satisfies z.ZodType<…>` against bd's exported types
// trips typecheck if bd's shape drifts from this mirror.
const bdDuplicatesClusterMemberSchema = z.object({
  beadsId: z.string(),
  title: z.string().default(""),
  status: z.string().default(""),
  priority: z.number().int().nullable().default(null),
});
const bdDuplicatesClusterSchema = z.object({
  target: bdDuplicatesClusterMemberSchema,
  sources: z.array(bdDuplicatesClusterMemberSchema).nonempty(),
});
const bdDoctorIssueSchema = z.object({
  category: z.string(),
  count: z.number().int().nonnegative().default(0),
  fixable: z.boolean().default(false),
});
const bdDoctorReportSchema = z.object({
  total: z.number().int().nonnegative().default(0),
  fixable: z.number().int().nonnegative().default(0),
  issues: z.array(bdDoctorIssueSchema).default([]),
});

export const driftFixPlanSchema = z.object({
  repo: z.string().min(1),
  generatedAt: z.string(),
  rows: z.array(driftFixPlanRowSchema),
  // GH-1255: bd substrate dedupe + health surfaces alongside the axis plan.
  // `duplicates` holds the raw `bd duplicates --dry-run` cluster output so
  // downstream consumers (report, audit replay) can re-derive the pair list
  // without re-querying bd. `substrateHealth` mirrors `bd doctor --json`.
  duplicates: z.array(bdDuplicatesClusterSchema).default([]),
  substrateHealth: bdDoctorReportSchema.default(emptyBdDoctorReport),
});

export type DriftFixPlan = z.infer<typeof driftFixPlanSchema>;

export type ReadTextFile = (path: string, encoding: "utf8") => string;

export type TriageDriftFixDeps = {
  execBd?: typeof defaultExecBd;
  listOpenIssues?: typeof defaultListOpenIssues;
  repoNameWithOwner?: typeof defaultRepoNameWithOwner;
  loadAllBeads?: (exec: typeof defaultExecBd) => BeadsRecord[];
  cwd?: () => string;
  now?: () => Date;
  readFileSync?: ReadTextFile;
  readStdin?: () => string;
  /** GH-1403 — sink-side DI for the unified daily NDJSON audit. */
  auditSink?: AuditSinkDeps;
  /**
   * Canonical reconcile chained after label writes (GH-2316: replaces the
   * retired destructive bd-side reconcile shell-out, which could clobber
   * bd-canonical priority on its pull leg). The sanctioned surface is
   * `prx sync issues --from gh --to bd`, which delegates to `runBeadsSync`.
   * Default delegates to `defaultRunBeadsSync`.
   */
  runBeadsSync?: typeof defaultRunBeadsSync;
  /**
   * GH-1595 — drop the per-invocation `BeadsCache` after each successful
   * `bd update` in the apply phase. Missing/no-op on test paths.
   */
  invalidateBeadsCache?: () => void;
  /**
   * GH-296 / prx-ebo — daemon-routed bulk WRITE seams. The apply phase mutates
   * beads through these (the trusted single writer) instead of host `bd` against
   * a per-clone .beads. Default to the beadsd helpers; tests inject fakes. Both
   * throw on a non-ok daemon verdict.
   */
  updateBead?: typeof updateBeadViaDaemon;
  reopenBead?: typeof reopenBeadViaDaemon;
  // GH-1255: bd-substrate dedupe + health probes. Injected as functions
  // closing over the `cwd` so test fixtures can return canned shapes without
  // a real `bd` binary; production callers leave them unset and the verb
  // resolves the default wrapper with the active `cwd`.
  runBdDuplicatesDryRun?: () => BdDuplicatesDryRunResult;
  runBdDoctorJson?: () => BdDoctorResult;
  runBdDoctorFix?: () => BdDoctorResult;
  runBdMerge?: (opts: BdMergeOptions) => BdMergeResult;
};

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type DriftFixAuditRowEntry = {
  ts: string;
  issue: number;
  beadsId: string;
  action: "update" | "skip" | "error";
  decision: DriftFixDecision;
  axesFixed?: DriftFixAxis[];
  beforeAfter?: {
    type?: { before: string; after: TypeLabel };
    priority?: { before: string; after: PriorityLabel };
    status?: { before: "closed"; after: "open" };
  };
  actor: "claude-code";
  dryRun: boolean;
  exitCode: number;
  stderr?: string;
};

export type DriftFixAuditSyncEntry = {
  ts: string;
  action: "sync";
  touchedIssues: number[];
  actor: "claude-code";
  dryRun: false;
  bdExitCode: number;
  bdStdout: string;
  bdStderr?: string;
};

// GH-1255 — dupe-cluster surface + merge proposal audit shapes.
export type DriftFixDupeDetectedEntry = {
  ts: string;
  action: "dupe-detected";
  beadsTarget: string;
  beadsSource: string;
  parityOk: boolean;
  parityReason: string | null;
  actor: "claude-code";
  dryRun: boolean;
  exitCode: 0;
};

export type DriftFixDupeMergeEntry = {
  ts: string;
  action: "dupe-merge";
  beadsTarget: string;
  beadsSource: string;
  parityOk: boolean;
  applied: boolean;
  actor: "claude-code";
  dryRun: boolean;
  exitCode: number;
  reason?: string;
  stderr?: string;
};

export type DriftFixDoctorEntry = {
  ts: string;
  action: "doctor-health";
  total: number;
  fixable: number;
  applied: boolean;
  issues: Array<{ category: string; count: number; fixable: boolean }>;
  actor: "claude-code";
  dryRun: boolean;
  exitCode: number;
  stderr?: string;
};

export type DriftFixAuditEntry =
  | DriftFixAuditRowEntry
  | DriftFixAuditSyncEntry
  | DriftFixDupeDetectedEntry
  | DriftFixDupeMergeEntry
  | DriftFixDoctorEntry;

export type DriftFixSyncOutcome = "ok" | "failed" | "skipped";

function isBdType(value: string): value is (typeof BD_TYPE_ENUM)[number] {
  return (BD_TYPE_ENUM as readonly string[]).includes(value);
}

// Project a `DriftRow` into a `DriftFixPlanRow` decision. Pure and synchronous
// so it's trivially table-tested. Implements the rules in the file header.
export function selectDriftFixDecision(
  drift: DriftRow,
  axes: readonly DriftFixAxis[],
): DriftFixPlanRow {
  const wantType = axes.includes("type");
  const wantPriority = axes.includes("priority");
  const wantStatus = axes.includes("status");

  // Type/priority/status pairs that the row carries forward into the plan,
  // regardless of decision, so the apply phase / audit log have full context.
  // Computed first so the in-scope predicates can depend on Zod-validated
  // pairs rather than raw nullable extractions (GH-1783): the planner's
  // inclusion gate and the apply phase's carry-forward gate were skewed,
  // emitting `decision=fix` rows with `axesFixed` including an axis whose
  // GH-side label failed Zod validation.
  const typePair = drift.fields.type ? driftTypePairSchema.safeParse(drift.fields.type) : null;
  const priorityPair = drift.fields.priority
    ? driftPriorityPairSchema.safeParse(drift.fields.priority)
    : null;
  const statusPair = drift.fields.status
    ? driftStatusPairSchema.safeParse(drift.fields.status)
    : null;

  const carriedType = typePair?.success ? typePair.data : undefined;
  const carriedPriority = priorityPair?.success ? priorityPair.data : undefined;
  const carriedStatus = statusPair?.success ? statusPair.data : undefined;

  const ghType = drift.fields.type?.gh ?? null;
  const bdType = drift.fields.type?.bd ?? null;

  const typeDriftInScope =
    wantType && carriedType !== undefined && ghType !== null && bdType !== null;
  const priorityDriftInScope = wantPriority && carriedPriority !== undefined;
  const statusDriftInScope = wantStatus && carriedStatus !== undefined;

  const base = {
    issueNumber: drift.issueNumber,
    beadsId: drift.beadsId,
  } as const;

  // GH-1783: hard-skip rows where the operator wants an axis fixed but the
  // GH-side label fails the Zod vocab schema (e.g. legacy `priority::P1`,
  // `priority::p0`, `priority::minor`, or `type::decision`). Partial fixes
  // would be confusing; the operator must clean up the GH label first.
  // Mirrors the `skip:no-bd-type` precedent below.
  const unpairedAxes: DriftFixAxis[] = [];
  if (wantType && drift.fields.type !== undefined && carriedType === undefined) {
    unpairedAxes.push("type");
  }
  if (wantPriority && drift.fields.priority !== undefined && carriedPriority === undefined) {
    unpairedAxes.push("priority");
  }
  if (wantStatus && drift.fields.status !== undefined && carriedStatus === undefined) {
    unpairedAxes.push("status");
  }
  if (unpairedAxes.length > 0) {
    return {
      ...base,
      decision: "skip:no-pair",
      reason: `${unpairedAxes.join("+")} drift exists but GH label out-of-vocab; cannot pair`,
      ...(carriedType ? { type: carriedType } : {}),
      ...(carriedPriority ? { priority: carriedPriority } : {}),
      ...(carriedStatus ? { status: carriedStatus } : {}),
    };
  }

  // findDrift() may flag rows for title only (which we ignore here).
  if (!typeDriftInScope && !priorityDriftInScope && !statusDriftInScope) {
    const hasAnyAxisDrift =
      drift.fields.type !== undefined ||
      drift.fields.priority !== undefined ||
      drift.fields.status !== undefined;
    if (!hasAnyAxisDrift) {
      return {
        ...base,
        decision: "skip:no-axis-drift",
        reason: "drift is on title only, not type/priority/status",
        ...(carriedType ? { type: carriedType } : {}),
        ...(carriedPriority ? { priority: carriedPriority } : {}),
        ...(carriedStatus ? { status: carriedStatus } : {}),
      };
    }
    return {
      ...base,
      decision: "skip:axis-filtered",
      reason: `drift exists but excluded via --axes ${axes.join(",")}`,
      ...(carriedType ? { type: carriedType } : {}),
      ...(carriedPriority ? { priority: carriedPriority } : {}),
      ...(carriedStatus ? { status: carriedStatus } : {}),
    };
  }

  // Type-axis vocab boundary: bd's `--type` enum doesn't accept spike/refactor.
  // Hard-skip the entire row so we don't half-fix it. Operators can re-run
  // with `--axes priority,status` to handle the other axes independently.
  if (typeDriftInScope && ghType !== null && !isBdType(ghType)) {
    return {
      ...base,
      decision: "skip:no-bd-type",
      reason: `GH type "${ghType}" not in BD_TYPE_ENUM (bd cannot accept spike/refactor as core types)`,
      ...(carriedType ? { type: carriedType } : {}),
      ...(carriedPriority ? { priority: carriedPriority } : {}),
      ...(carriedStatus ? { status: carriedStatus } : {}),
    };
  }

  const axesFixed: DriftFixAxis[] = [];
  if (typeDriftInScope) axesFixed.push("type");
  if (priorityDriftInScope) axesFixed.push("priority");
  if (statusDriftInScope) axesFixed.push("status");

  return {
    ...base,
    decision: "fix",
    reason: `${axesFixed.join("+")} drift in scope`,
    axesFixed,
    ...(carriedType ? { type: carriedType } : {}),
    ...(carriedPriority ? { priority: carriedPriority } : {}),
    ...(carriedStatus ? { status: carriedStatus } : {}),
  };
}

export function buildDriftFixPlan(
  drift: DriftRow[],
  repo: string,
  generatedAt: string,
  axes: readonly DriftFixAxis[],
): DriftFixPlan {
  const rows = drift.map((d) => selectDriftFixDecision(d, axes));
  return driftFixPlanSchema.parse({ repo, generatedAt, rows });
}

// GH-1255 — parity check for a (target, source) bd dupe-cluster pair.
//
// The 2026-05-02 @bdelanghe comment substitutes the operator-confirmation
// prompt with a structural parity gate: a `bd merge` exec fires iff the two
// records agree on priority AND on the set of `area::*` labels carried by
// their GH twins. The first mismatch reported is the audit `parityReason`;
// `area::*` parity falls back to "no-gh-twin" when either bd record lacks a
// resolved GH issue (the wrapper can still surface the cluster but cannot
// safely auto-merge it).
function areaLabelSet(labels: readonly { name: string }[] | undefined): Set<string> {
  const out = new Set<string>();
  if (!labels) return out;
  for (const label of labels) {
    if (label.name.startsWith("area::")) out.add(label.name);
  }
  return out;
}

function areasEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

export type DriftFixParityCheck = {
  parityOk: boolean;
  parityReason: string | null;
};

export function checkDuplicateParity(
  target: BeadsRecord | undefined,
  source: BeadsRecord | undefined,
  ghLabelsByBeadsId: Map<string, FallbackIssue["labels"]>,
): DriftFixParityCheck {
  if (!target || !source) {
    return {
      parityOk: false,
      parityReason: "missing bd record for target or source",
    };
  }
  if (target.priority !== source.priority) {
    return {
      parityOk: false,
      parityReason: `priority mismatch: target=${target.priority ?? "null"} source=${source.priority ?? "null"}`,
    };
  }
  const targetLabels = ghLabelsByBeadsId.get(target.id);
  const sourceLabels = ghLabelsByBeadsId.get(source.id);
  if (targetLabels === undefined || sourceLabels === undefined) {
    return {
      parityOk: false,
      parityReason: "no-gh-twin: cannot verify area::* parity without GH labels",
    };
  }
  const targetAreas = areaLabelSet(targetLabels);
  const sourceAreas = areaLabelSet(sourceLabels);
  if (!areasEqual(targetAreas, sourceAreas)) {
    const tList = [...targetAreas].sort().join(",") || "(none)";
    const sList = [...sourceAreas].sort().join(",") || "(none)";
    return {
      parityOk: false,
      parityReason: `area::* mismatch: target=[${tList}] source=[${sList}]`,
    };
  }
  return { parityOk: true, parityReason: null };
}

// GH-1255 — project one `BdDuplicatesCluster` into per-pair `fix:dupe` rows
// (one row per (target, source) pair). Pure / synchronous — mirrors
// `selectDriftFixDecision`'s shape. `issueNumber` falls back to 0 when the
// source bd record lacks a paired GH issue; the apply phase honors the
// sentinel.
export function selectDuplicateDecision(
  cluster: BdDuplicatesCluster,
  beadsById: Map<string, BeadsRecord>,
  ghLabelsByBeadsId: Map<string, FallbackIssue["labels"]>,
): DriftFixPlanRow[] {
  const target = beadsById.get(cluster.target.beadsId);
  const rows: DriftFixPlanRow[] = [];
  for (const member of cluster.sources) {
    const source = beadsById.get(member.beadsId);
    const parity = checkDuplicateParity(target, source, ghLabelsByBeadsId);
    const issueNumber = source?.externalIssueNumber ?? 0;
    rows.push({
      issueNumber,
      beadsId: member.beadsId,
      decision: "fix:dupe",
      reason: parity.parityOk
        ? `bd-duplicate of ${cluster.target.beadsId} (parity ok)`
        : `bd-duplicate of ${cluster.target.beadsId} (${parity.parityReason})`,
      dupe: {
        target: cluster.target.beadsId,
        source: member.beadsId,
        parityOk: parity.parityOk,
        parityReason: parity.parityReason,
      },
    });
  }
  return rows;
}

function readStdinSync(): string {
  const fs = require("node:fs") as typeof import("node:fs");
  return fs.readFileSync(0, "utf8");
}

function loadPlan(
  source: string | undefined,
  deps: TriageDriftFixDeps,
  output: Output,
): DriftFixPlan | null {
  let raw: string;
  try {
    if (!source || source === "-") {
      const reader = deps.readStdin ?? readStdinSync;
      raw = reader();
    } else {
      const reader: ReadTextFile =
        deps.readFileSync ?? ((p, e) => defaultReadFileSync(p, e) as string);
      raw = reader(source, "utf8");
    }
  } catch (err) {
    output.error(`triage drift-fix: failed to read plan: ${(err as Error).message}`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    output.error("triage drift-fix: plan is not valid JSON");
    return null;
  }
  try {
    return driftFixPlanSchema.parse(parsed);
  } catch (err) {
    output.error(`triage drift-fix: plan failed schema validation: ${(err as Error).message}`);
    return null;
  }
}

// Shared between scan / one-shot apply: fetch GH + bd state, build the plan.
function buildPlanFromGitHubAndBeads(
  opts: TriageDriftFixOptions,
  output: Output,
  deps: TriageDriftFixDeps,
): DriftFixPlan | null {
  const listIssues = deps.listOpenIssues ?? defaultListOpenIssues;
  const resolveRepo = deps.repoNameWithOwner ?? defaultRepoNameWithOwner;
  const bdExec = deps.execBd ?? defaultExecBd;
  const loadBeads = deps.loadAllBeads ?? loadAllBeads;
  const cwd = (deps.cwd ?? process.cwd)();
  const now = (deps.now ?? (() => new Date()))();

  const repo = opts.repo ?? resolveRepo(cwd);
  const ghLimit = opts.limit > 0 ? opts.limit : 1000;

  let issues: FallbackIssue[];
  try {
    issues = listIssues(repo, ghLimit);
  } catch (err) {
    output.error(`triage drift-fix: failed to list issues: ${(err as Error).message}`);
    return null;
  }

  let beads: BeadsRecord[];
  try {
    beads = loadBeads(bdExec);
  } catch (err) {
    output.error(`triage drift-fix: ${(err as Error).message}`);
    return null;
  }

  const drift = findDrift(beads, issues);
  const basePlan = buildDriftFixPlan(drift, repo, now.toISOString(), opts.axes);

  // GH-1255: dupe scan + substrate-health pass.
  let duplicates: BdDuplicatesCluster[] = [];
  let substrateHealth: BdDoctorReport = emptyBdDoctorReport;
  const dupeRows: DriftFixPlanRow[] = [];

  if (opts.includeDupes) {
    const dupeRunner = deps.runBdDuplicatesDryRun ?? (() => defaultRunBdDuplicatesDryRun(cwd));
    const dupeResult = dupeRunner();
    if (dupeResult.exitCode === 0) {
      duplicates = dupeResult.clusters;
      const beadsById = indexBeadsById(beads);
      const ghLabelsByBeadsId = new Map<string, FallbackIssue["labels"]>();
      const issuesByNumber = new Map<number, FallbackIssue>();
      for (const issue of issues) issuesByNumber.set(issue.number, issue);
      for (const bead of beads) {
        const n = bead.externalIssueNumber;
        if (n === null) continue;
        const matched = issuesByNumber.get(n);
        if (matched) ghLabelsByBeadsId.set(bead.id, matched.labels);
      }
      for (const cluster of duplicates) {
        dupeRows.push(...selectDuplicateDecision(cluster, beadsById, ghLabelsByBeadsId));
      }
    } else {
      const detail = dupeResult.stderr.trim() || dupeResult.stdout.trim();
      output.error(
        detail
          ? `triage drift-fix: bd duplicates failed (${dupeResult.exitCode}): ${detail}`
          : `triage drift-fix: bd duplicates failed (${dupeResult.exitCode})`,
      );
    }
  }

  if (opts.includeDoctor) {
    const doctorRunner = deps.runBdDoctorJson ?? (() => defaultRunBdDoctorJson(cwd));
    const doctorResult = doctorRunner();
    if (doctorResult.exitCode === 0) {
      substrateHealth = doctorResult.report;
    } else {
      const detail = doctorResult.stderr.trim() || doctorResult.stdout.trim();
      output.error(
        detail
          ? `triage drift-fix: bd doctor failed (${doctorResult.exitCode}): ${detail}`
          : `triage drift-fix: bd doctor failed (${doctorResult.exitCode})`,
      );
    }
  }

  return driftFixPlanSchema.parse({
    repo: basePlan.repo,
    generatedAt: basePlan.generatedAt,
    rows: [...basePlan.rows, ...dupeRows],
    duplicates,
    substrateHealth,
  });
}

function runScanPhase(
  opts: TriageDriftFixOptions,
  output: Output,
  deps: TriageDriftFixDeps,
): number {
  const plan = buildPlanFromGitHubAndBeads(opts, output, deps);
  if (!plan) return 1;
  output.log(JSON.stringify(plan, null, 2));
  return 0;
}

// Re-check the bd record at apply time to short-circuit rows where the bd
// columns already match the planned GH values for every axis the row fixes
// (the plan may be stale).
function rowAlreadyMatches(row: DriftFixPlanRow, beadsById: Map<string, BeadsRecord>): boolean {
  if (row.decision !== "fix" || !row.axesFixed) return false;
  const bead = beadsById.get(row.beadsId);
  if (!bead) return false;
  for (const axis of row.axesFixed) {
    if (axis === "type") {
      if (!row.type || bead.issueType !== row.type.gh) return false;
    } else if (axis === "priority") {
      if (!row.priority) return false;
      // priority::none means "operator-undecided" — never treat that as a match,
      // so the apply phase's hard error fires deterministically.
      if (row.priority.gh === "none") return false;
      const wantedNum = priorityToBdNumber(row.priority.gh);
      if (bead.priority !== wantedNum) return false;
    } else if (axis === "status") {
      // We only fix bd=closed→open. A bead already at "open" is a match.
      if (bead.status !== "open") return false;
    }
  }
  return true;
}

function indexBeadsById(records: BeadsRecord[]): Map<string, BeadsRecord> {
  const out = new Map<string, BeadsRecord>();
  for (const r of records) out.set(r.id, r);
  return out;
}

// Walk a validated plan and execute the writes. Shared between two-phase
// apply (`--from`) and one-shot apply (`--apply`).
async function applyPlan(
  plan: DriftFixPlan,
  opts: TriageDriftFixOptions,
  output: Output,
  deps: TriageDriftFixDeps,
): Promise<number> {
  const exec = deps.execBd ?? defaultExecBd;
  const loadBeads = deps.loadAllBeads ?? loadAllBeads;
  // GH-296 / prx-ebo — writes go to the daemon (single writer), not host bd.
  const updateBead = deps.updateBead ?? updateBeadViaDaemon;
  const reopenBead = deps.reopenBead ?? reopenBeadViaDaemon;
  const now = (deps.now ?? (() => new Date()))();
  const auditSink: AuditSinkDeps = {
    ...(deps.auditSink ?? {}),
    now: deps.auditSink?.now ?? (() => now),
  };
  const append = (entry: DriftFixAuditEntry): void => appendAuditRow(entry, auditSink);

  let rows = plan.rows;
  if (opts.limit > 0) rows = rows.slice(0, opts.limit);

  const logPath = auditSinkPath(now, {
    stateDirOverride: auditSink.stateDirOverride,
    env: auditSink.env,
  });

  let beads: BeadsRecord[];
  try {
    beads = loadBeads(exec);
  } catch (err) {
    output.error(`triage drift-fix: ${(err as Error).message}`);
    return 1;
  }
  const beadsById = indexBeadsById(beads);

  let writes = 0;
  let skips = 0;
  let errors = 0;
  const touchedIssues: number[] = [];

  for (const row of rows) {
    const baseEntry = {
      ts: now.toISOString(),
      issue: row.issueNumber,
      beadsId: row.beadsId,
      decision: row.decision,
      actor: "claude-code" as const,
      dryRun: opts.dryRun,
    };

    // GH-1255 — bd-substrate dupe-cluster merge proposal. Parity-gated:
    // a `bd merge` exec fires iff `parityOk && opts.applyDupes && !dryRun`.
    // Otherwise the row contributes a `dupe-detected` + `dupe-merge`
    // (applied=false) audit pair and counts as a skip.
    if (row.decision === "fix:dupe") {
      if (!row.dupe) {
        // Defensive — superRefine would have rejected this, but the schema
        // parse can be skipped on hand-built plans. Audit + skip.
        const entry: DriftFixAuditRowEntry = {
          ...baseEntry,
          action: "error",
          exitCode: 1,
          stderr: "fix:dupe row missing dupe carrier",
        };
        append(entry);
        output.error(`error ${row.beadsId}: fix:dupe row missing dupe carrier`);
        errors += 1;
        continue;
      }
      const dupe = row.dupe;
      const detected: DriftFixDupeDetectedEntry = {
        ts: now.toISOString(),
        action: "dupe-detected",
        beadsTarget: dupe.target,
        beadsSource: dupe.source,
        parityOk: dupe.parityOk,
        parityReason: dupe.parityReason,
        actor: "claude-code",
        dryRun: opts.dryRun,
        exitCode: 0,
      };
      append(detected);

      if (!dupe.parityOk) {
        const merge: DriftFixDupeMergeEntry = {
          ts: now.toISOString(),
          action: "dupe-merge",
          beadsTarget: dupe.target,
          beadsSource: dupe.source,
          parityOk: false,
          applied: false,
          actor: "claude-code",
          dryRun: opts.dryRun,
          exitCode: 0,
          reason: "parity-mismatch",
        };
        append(merge);
        output.log(
          `skip ${dupe.source} (dupe: parity-mismatch ${dupe.parityReason ?? ""})`.trimEnd(),
        );
        skips += 1;
        continue;
      }

      if (opts.dryRun || !opts.applyDupes) {
        const reason = opts.dryRun ? undefined : "apply-dupes-disabled";
        const merge: DriftFixDupeMergeEntry = {
          ts: now.toISOString(),
          action: "dupe-merge",
          beadsTarget: dupe.target,
          beadsSource: dupe.source,
          parityOk: true,
          applied: false,
          actor: "claude-code",
          dryRun: opts.dryRun,
          exitCode: 0,
          ...(reason ? { reason } : {}),
        };
        append(merge);
        if (opts.dryRun) {
          output.log(`dry-run bd merge ${dupe.source} --into ${dupe.target}`);
          writes += 1;
          if (row.issueNumber > 0) touchedIssues.push(row.issueNumber);
        } else {
          output.log(`skip ${dupe.source} (dupe: apply-dupes-disabled)`);
          skips += 1;
        }
        continue;
      }

      // Real merge.
      const mergeRunner =
        deps.runBdMerge ??
        ((mergeOpts) => defaultRunBdMerge((deps.cwd ?? process.cwd)(), mergeOpts));
      const mergeResult = mergeRunner({
        target: dupe.target,
        sources: [dupe.source],
        dryRun: false,
      });
      if (mergeResult.exitCode !== 0) {
        const stderr = mergeResult.stderr.trim() || "bd merge failed";
        const merge: DriftFixDupeMergeEntry = {
          ts: now.toISOString(),
          action: "dupe-merge",
          beadsTarget: dupe.target,
          beadsSource: dupe.source,
          parityOk: true,
          applied: false,
          actor: "claude-code",
          dryRun: false,
          exitCode: mergeResult.exitCode,
          stderr,
        };
        append(merge);
        output.error(
          `error bd merge ${dupe.source} → ${dupe.target} exit=${mergeResult.exitCode}: ${stderr}`,
        );
        errors += 1;
        continue;
      }

      const merge: DriftFixDupeMergeEntry = {
        ts: now.toISOString(),
        action: "dupe-merge",
        beadsTarget: dupe.target,
        beadsSource: dupe.source,
        parityOk: true,
        applied: true,
        actor: "claude-code",
        dryRun: false,
        exitCode: 0,
      };
      append(merge);
      deps.invalidateBeadsCache?.();
      output.log(`merge ${dupe.source} → ${dupe.target} (parity ok)`);
      writes += 1;
      if (row.issueNumber > 0) touchedIssues.push(row.issueNumber);
      continue;
    }

    if (row.decision !== "fix") {
      const entry: DriftFixAuditRowEntry = {
        ...baseEntry,
        action: "skip",
        exitCode: 0,
      };
      append(entry);
      output.log(`skip GH-${row.issueNumber} (${row.decision})`);
      skips += 1;
      continue;
    }

    const axesFixed = row.axesFixed ?? [];
    const fixesType = axesFixed.includes("type");
    const fixesPriority = axesFixed.includes("priority");
    const fixesStatus = axesFixed.includes("status");

    // Defensive idempotency — bd may already match the planned GH state.
    if (rowAlreadyMatches(row, beadsById)) {
      const entry: DriftFixAuditRowEntry = {
        ...baseEntry,
        action: "skip",
        exitCode: 0,
        stderr: "bd row already matches GH",
      };
      append(entry);
      output.log(`skip GH-${row.issueNumber} (already-matches)`);
      skips += 1;
      continue;
    }

    // Validate axes have the data they need before any exec runs. Audit a
    // single error entry per row on schema violation.
    if (fixesType && !row.type) {
      const entry: DriftFixAuditRowEntry = {
        ...baseEntry,
        action: "error",
        exitCode: 1,
        stderr: "axesFixed includes type but row has no type pair",
      };
      append(entry);
      output.error(`error GH-${row.issueNumber}: axesFixed includes type but row has no type pair`);
      errors += 1;
      continue;
    }
    if (fixesPriority && !row.priority) {
      const entry: DriftFixAuditRowEntry = {
        ...baseEntry,
        action: "error",
        exitCode: 1,
        stderr: "axesFixed includes priority but row has no priority pair",
      };
      append(entry);
      output.error(
        `error GH-${row.issueNumber}: axesFixed includes priority but row has no priority pair`,
      );
      errors += 1;
      continue;
    }
    if (fixesPriority && row.priority?.gh === "none") {
      const entry: DriftFixAuditRowEntry = {
        ...baseEntry,
        action: "error",
        exitCode: 1,
        stderr: "fix priority row has priority::none (operator-undecided)",
      };
      append(entry);
      output.error(`error GH-${row.issueNumber}: priority::none is operator-undecided, cannot fix`);
      errors += 1;
      continue;
    }
    if (fixesStatus && !row.status) {
      const entry: DriftFixAuditRowEntry = {
        ...baseEntry,
        action: "error",
        exitCode: 1,
        stderr: "axesFixed includes status but row has no status pair",
      };
      append(entry);
      output.error(
        `error GH-${row.issueNumber}: axesFixed includes status but row has no status pair`,
      );
      errors += 1;
      continue;
    }

    const beforeAfter: DriftFixAuditRowEntry["beforeAfter"] = {};
    if (fixesType && row.type) {
      beforeAfter.type = { before: row.type.bd, after: row.type.gh };
    }
    if (fixesPriority && row.priority) {
      beforeAfter.priority = { before: row.priority.bd, after: row.priority.gh };
    }
    if (fixesStatus && row.status) {
      beforeAfter.status = { before: "closed", after: "open" };
    }

    if (opts.dryRun) {
      const planned: string[] = [];
      if (fixesType || fixesPriority) {
        const updateArgs: string[] = [row.beadsId];
        if (fixesType && row.type) updateArgs.push("--type", row.type.gh);
        if (fixesPriority && row.priority && row.priority.gh !== "none") {
          updateArgs.push("-p", String(priorityToBdNumber(row.priority.gh)));
        }
        planned.push(`bd update ${updateArgs.join(" ")}`);
      }
      if (fixesStatus) planned.push(`bd reopen ${row.beadsId}`);

      const entry: DriftFixAuditRowEntry = {
        ...baseEntry,
        action: "update",
        axesFixed,
        beforeAfter,
        exitCode: 0,
      };
      append(entry);
      output.log(`dry-run GH-${row.issueNumber} ${planned.join(" && ")}`);
      writes += 1;
      touchedIssues.push(row.issueNumber);
      continue;
    }

    // Execute. If the row touches type/priority, run `bd update` first; then
    // `bd reopen` if status drifted. Either failure marks the row as error
    // and `axesFixed` records what actually got applied so the audit log
    // reflects partial state.
    const appliedAxes: DriftFixAxis[] = [];
    let updateError: { exitCode: number; message: string } | null = null;

    if (fixesType || fixesPriority) {
      const updateFields: { issueType?: string; priority?: number } = {};
      if (fixesType && row.type) updateFields.issueType = row.type.gh;
      if (fixesPriority && row.priority && row.priority.gh !== "none") {
        updateFields.priority = priorityToBdNumber(row.priority.gh);
      }
      try {
        await updateBead(row.beadsId, updateFields);
        if (fixesType) appliedAxes.push("type");
        if (fixesPriority) appliedAxes.push("priority");
      } catch (err) {
        // The daemon helper throws on a non-ok verdict (vs execBd's exit code);
        // synthesize the same error shape the audit row expects.
        updateError = { exitCode: 1, message: (err as Error).message || "bd update failed" };
      }
    }

    if (!updateError && fixesStatus) {
      let reopenError: string | null = null;
      try {
        await reopenBead(row.beadsId);
      } catch (err) {
        reopenError = (err as Error).message || "bd reopen failed";
      }
      if (reopenError !== null) {
        const entry: DriftFixAuditRowEntry = {
          ...baseEntry,
          action: "error",
          axesFixed: appliedAxes,
          beforeAfter,
          exitCode: 1,
          stderr: reopenError,
        };
        append(entry);
        output.error(`error GH-${row.issueNumber} bd reopen failed: ${entry.stderr}`);
        // If type/priority went through but reopen failed, the row counts as
        // both a partial-write *and* an error. Track the touched issue for
        // sync, then mark error so the exit code reflects the failure.
        if (appliedAxes.length > 0) {
          writes += 1;
          touchedIssues.push(row.issueNumber);
        }
        errors += 1;
        continue;
      }
      appliedAxes.push("status");
    }

    if (updateError) {
      const entry: DriftFixAuditRowEntry = {
        ...baseEntry,
        action: "error",
        axesFixed: appliedAxes,
        beforeAfter,
        exitCode: updateError.exitCode,
        stderr: updateError.message,
      };
      append(entry);
      output.error(
        `error GH-${row.issueNumber} bd update exit=${updateError.exitCode}: ${updateError.message}`,
      );
      errors += 1;
      continue;
    }

    const entry: DriftFixAuditRowEntry = {
      ...baseEntry,
      action: "update",
      axesFixed: appliedAxes,
      beforeAfter,
      exitCode: 0,
    };
    append(entry);
    deps.invalidateBeadsCache?.();
    output.log(`update GH-${row.issueNumber} (${appliedAxes.join("+")})`);
    writes += 1;
    touchedIssues.push(row.issueNumber);
  }

  // GH-1255 — substrate-health surface. Emit a `doctor-health` audit row
  // whenever the plan carried any reported issues; the operator can then
  // re-run with `--doctor-fix` to land the bd-side fix. Read-only by default.
  if (plan.substrateHealth.total > 0) {
    const doctorEntry: DriftFixDoctorEntry = {
      ts: now.toISOString(),
      action: "doctor-health",
      total: plan.substrateHealth.total,
      fixable: plan.substrateHealth.fixable,
      applied: false,
      issues: plan.substrateHealth.issues.map((i) => ({
        category: i.category,
        count: i.count,
        fixable: i.fixable,
      })),
      actor: "claude-code",
      dryRun: opts.dryRun,
      exitCode: 0,
    };
    append(doctorEntry);
    output.log(
      `bd doctor: total=${plan.substrateHealth.total} fixable=${plan.substrateHealth.fixable}`,
    );

    if (opts.doctorFix && !opts.dryRun && plan.substrateHealth.fixable > 0) {
      const cwd = (deps.cwd ?? process.cwd)();
      const doctorFixRunner = deps.runBdDoctorFix ?? (() => defaultRunBdDoctorFix(cwd));
      const fixResult = doctorFixRunner();
      if (fixResult.exitCode === 0) {
        const fixedEntry: DriftFixDoctorEntry = {
          ts: now.toISOString(),
          action: "doctor-health",
          total: fixResult.report.total,
          fixable: fixResult.report.fixable,
          applied: true,
          issues: fixResult.report.issues.map((i) => ({
            category: i.category,
            count: i.count,
            fixable: i.fixable,
          })),
          actor: "claude-code",
          dryRun: false,
          exitCode: 0,
        };
        append(fixedEntry);
        output.log(`bd doctor --fix applied: post total=${fixResult.report.total}`);
      } else {
        const stderr = fixResult.stderr.trim() || "bd doctor --fix failed";
        const fixedEntry: DriftFixDoctorEntry = {
          ts: now.toISOString(),
          action: "doctor-health",
          total: plan.substrateHealth.total,
          fixable: plan.substrateHealth.fixable,
          applied: false,
          issues: plan.substrateHealth.issues.map((i) => ({
            category: i.category,
            count: i.count,
            fixable: i.fixable,
          })),
          actor: "claude-code",
          dryRun: false,
          exitCode: fixResult.exitCode,
          stderr,
        };
        append(fixedEntry);
        output.error(`error bd doctor --fix exit=${fixResult.exitCode}: ${stderr}`);
        errors += 1;
      }
    }
  }

  // Canonical reconcile chain — mirrors apply.ts (GH-2316: the destructive
  // `--pull-only --prefer-github` shell-out was retired so a `priority::*`
  // label can no longer round-trip into bd-canonical priority; I-DS-PRIO).
  let syncOutcome: DriftFixSyncOutcome = "skipped";
  if (!opts.dryRun && opts.sync && writes > 0) {
    const beadsSync = deps.runBeadsSync ?? defaultRunBeadsSync;
    const syncCapture: { stdout: string[]; stderr: string[] } = { stdout: [], stderr: [] };
    const syncOutput = {
      log: (line: string) => syncCapture.stdout.push(line),
      error: (line: string) => syncCapture.stderr.push(line),
    };
    const syncResult: BeadsSyncResult = await beadsSync(
      {
        repo: opts.repo,
        domain: "gh",
        dryRun: false,
        limit: DEFAULT_SYNC_LIMIT,
        format: "plain",
      },
      syncOutput,
    );
    const stderrTrimmed = syncCapture.stderr.join("\n").trim();
    const syncEntry: DriftFixAuditSyncEntry = {
      ts: now.toISOString(),
      action: "sync",
      touchedIssues,
      actor: "claude-code",
      dryRun: false,
      bdExitCode: syncResult.exitCode,
      bdStdout: syncCapture.stdout.join("\n").trim(),
      ...(stderrTrimmed.length > 0 ? { bdStderr: stderrTrimmed } : {}),
    };
    append(syncEntry);

    if (syncResult.exitCode === 0) {
      syncOutcome = "ok";
      output.log(`OK bd github sync: ${touchedIssues.length} issue(s) reconciled`);
    } else {
      syncOutcome = "failed";
      const detail = stderrTrimmed || syncCapture.stdout.join("\n").trim();
      output.error(detail ? `FAIL bd github sync: ${detail}` : "FAIL bd github sync");
    }
  }

  output.log(
    `triage drift-fix: writes=${writes} skips=${skips} errors=${errors} sync=${syncOutcome} log=${logPath}`,
  );

  if (syncOutcome === "failed") return 1;
  return errors > 0 ? 1 : 0;
}

async function runReplayApplyPhase(
  opts: TriageDriftFixOptions,
  output: Output,
  deps: TriageDriftFixDeps,
): Promise<number> {
  const plan = loadPlan(opts.from, deps, output);
  if (!plan) return 1;
  return applyPlan(plan, opts, output, deps);
}

async function runOneShotApplyPhase(
  opts: TriageDriftFixOptions,
  output: Output,
  deps: TriageDriftFixDeps,
): Promise<number> {
  const plan = buildPlanFromGitHubAndBeads(opts, output, deps);
  if (!plan) return 1;
  return applyPlan(plan, opts, output, deps);
}

export async function runTriageDriftFix(
  opts: TriageDriftFixOptions,
  output: Output,
  deps: TriageDriftFixDeps = {},
): Promise<number> {
  if (opts.apply && opts.from) {
    output.error("triage drift-fix: --apply and --from are mutually exclusive");
    return 1;
  }
  if (opts.apply) return runOneShotApplyPhase(opts, output, deps);
  if (opts.from) return runReplayApplyPhase(opts, output, deps);
  return runScanPhase(opts, output, deps);
}

/**
 * Actor-shaped entry for `prx triage drift-fix`. Forces `apply: true` so the
 * machine's `driftFixing` state always runs the one-shot apply path; the scan
 * / replay invocation shapes stay reserved for the CLI surface. Captures
 * stdout / stderr and the audit JSONL rows the verb appends so the machine
 * (and the prime loop, via `context.driftFixResult`) can read the writes /
 * skips / errors totals without re-reading disk.
 *
 * Audit NDJSON writes still hit disk via the underlying sink (`appendAuditRow`,
 * routed through `auditSink.appendFn` when injected). The wrapper only
 * intercepts to build the in-memory mirror. Mirrors `runApplyActor` in
 * `apply.ts:203`.
 */
export type TriageDriftFixActorResult = {
  exitCode: number;
  audit: DriftFixAuditEntry[];
  stdout: string[];
  stderr: string[];
  writes: number;
  skips: number;
  errors: number;
  syncOutcome: DriftFixSyncOutcome;
  touchedIssues: number[];
  // GH-1255 — bd-substrate dedupe + health summaries. `duplicatesDetected`
  // counts (target, source) pairs surfaced (parity-ok OR mismatch);
  // `mergesApplied` counts successful `bd merge` execs; `mergesSkippedParity`
  // counts dupe rows that bd surfaced but the parity gate refused. `substrateHealth`
  // mirrors the plan's pre-fix doctor report plus a `fixed` flag when
  // `--doctor-fix` ran successfully.
  duplicatesDetected: number;
  mergesApplied: number;
  mergesSkippedParity: number;
  substrateHealth: { total: number; fixable: number; fixed: boolean };
};

export async function runDriftFixActor(
  opts: TriageDriftFixOptions,
  deps: TriageDriftFixDeps = {},
): Promise<TriageDriftFixActorResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const audit: DriftFixAuditEntry[] = [];

  const upstreamAppend = deps.auditSink?.appendFn;
  const captureDeps: TriageDriftFixDeps = {
    ...deps,
    auditSink: {
      ...(deps.auditSink ?? {}),
      appendFn: (path, line) => {
        try {
          audit.push(JSON.parse(line.trim()) as DriftFixAuditEntry);
        } catch {
          // ignore non-JSON lines
        }
        upstreamAppend?.(path, line);
      },
    },
  };
  const captureOutput: Output = {
    log: (line) => stdout.push(line),
    error: (line) => stderr.push(line),
  };

  // Force apply mode — the machine's `driftFixing` state owns the reconcile,
  // not a scan / replay. `from` is forbidden in tandem with `apply`, so clear
  // it defensively in case a caller injected one. `applyDupes: true` so the
  // parity-gated merges actually fire when the gate holds. `doctorFix` stays
  // off — the machine never auto-runs `bd doctor --fix`; the operator opts
  // in explicitly via the CLI.
  const effective: TriageDriftFixOptions = {
    ...opts,
    apply: true,
    from: undefined,
    applyDupes: true,
    doctorFix: opts.doctorFix ?? false,
  };
  const exitCode = await runTriageDriftFix(effective, captureOutput, captureDeps);

  let writes = 0;
  let skips = 0;
  let errors = 0;
  let syncOutcome: DriftFixSyncOutcome = "skipped";
  const touchedIssues: number[] = [];
  let duplicatesDetected = 0;
  let mergesApplied = 0;
  let mergesSkippedParity = 0;
  let substrateTotal = 0;
  let substrateFixable = 0;
  let substrateFixed = false;
  for (const entry of audit) {
    if (entry.action === "sync") {
      syncOutcome = entry.bdExitCode === 0 ? "ok" : "failed";
      continue;
    }
    if (entry.action === "dupe-detected") {
      duplicatesDetected += 1;
      continue;
    }
    if (entry.action === "dupe-merge") {
      if (entry.applied) {
        mergesApplied += 1;
      } else if (!entry.parityOk) {
        mergesSkippedParity += 1;
      }
      continue;
    }
    if (entry.action === "doctor-health") {
      if (entry.applied) {
        substrateFixed = true;
      } else {
        substrateTotal = entry.total;
        substrateFixable = entry.fixable;
      }
      continue;
    }
    if (entry.action === "update") {
      writes += 1;
      touchedIssues.push(entry.issue);
    } else if (entry.action === "skip") {
      skips += 1;
    } else if (entry.action === "error") {
      errors += 1;
    }
  }

  return {
    exitCode,
    audit,
    stdout,
    stderr,
    writes,
    skips,
    errors,
    syncOutcome,
    touchedIssues,
    duplicatesDetected,
    mergesApplied,
    mergesSkippedParity,
    substrateHealth: {
      total: substrateTotal,
      fixable: substrateFixable,
      fixed: substrateFixed,
    },
  };
}
