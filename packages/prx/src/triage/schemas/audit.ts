// Audit JSONL row schemas — one shape per verb, derived from the existing
// TS types in each verb file. The verb files retain their TS types as the
// authoritative declaration; these schemas are the runtime boundary the
// machine actors use to validate JSONL output (or in-memory captures from
// `runAs<Verb>Actor`).
//
// Forward-declared schemas (type-pass, prioritize-bulk, drift-fix) match
// the shapes documented in the sibling-ticket bodies. Their actors throw
// until those tickets fill them, but the schemas exist so downstream
// consumers (report, future TUI) can typecheck against them now.

import { z } from "zod";

import { priorityLabelSchema, typeLabelSchema } from "../label-vocab.ts";
import { promoteDecisionSchema } from "./decisions.ts";
import { promoteChildrenAuditEntrySchema } from "./promote-children.ts";

const actorLiteralSchema = z.literal("claude-code");

// `prx triage apply` (GH-919) — apply.ts:72-96.
export const applyAuditRowSchema = z.object({
  ts: z.string(),
  issue: z.number().int().positive(),
  url: z.string(),
  action: z.enum(["add-remove", "skip", "error"]),
  add: z.array(z.string()),
  remove: z.array(z.string()),
  prev: z.array(z.string()),
  proposed: z.array(z.string()),
  actor: actorLiteralSchema,
  dryRun: z.boolean(),
  exitCode: z.number().int(),
  stderr: z.string().optional(),
});
export type ApplyAuditRow = z.infer<typeof applyAuditRowSchema>;

export const applyAuditSyncSchema = z.object({
  ts: z.string(),
  action: z.literal("sync"),
  touchedIssues: z.array(z.number().int().positive()),
  actor: actorLiteralSchema,
  dryRun: z.literal(false),
  bdExitCode: z.number().int(),
  bdStdout: z.string(),
  bdStderr: z.string().optional(),
});
export type ApplyAuditSync = z.infer<typeof applyAuditSyncSchema>;

export const applyAuditSchema = z.union([applyAuditRowSchema, applyAuditSyncSchema]);
export type ApplyAudit = z.infer<typeof applyAuditSchema>;

// `prx triage prioritize` (GH-980) — prioritize.ts:80-105.
export const prioritizeAuditRowSchema = z.object({
  ts: z.string(),
  issue: z.number().int().positive(),
  url: z.string(),
  action: z.enum(["decide", "skip", "quit", "error"]),
  decision: z.enum(["critical", "high", "medium", "low"]).optional(),
  add: z.array(z.string()),
  remove: z.array(z.string()),
  prev: z.array(z.string()),
  priorityConfidence: z.literal("operator"),
  actor: actorLiteralSchema,
  dryRun: z.boolean(),
  exitCode: z.number().int(),
  stderr: z.string().optional(),
});
export type PrioritizeAuditRow = z.infer<typeof prioritizeAuditRowSchema>;

export const prioritizeAuditSyncSchema = z.object({
  ts: z.string(),
  action: z.literal("sync"),
  touchedIssues: z.array(z.number().int().positive()),
  actor: actorLiteralSchema,
  dryRun: z.literal(false),
  bdExitCode: z.number().int(),
  bdStdout: z.string(),
  bdStderr: z.string().optional(),
});
export type PrioritizeAuditSync = z.infer<typeof prioritizeAuditSyncSchema>;

export const prioritizeAuditSchema = z.union([
  prioritizeAuditRowSchema,
  prioritizeAuditSyncSchema,
]);
export type PrioritizeAudit = z.infer<typeof prioritizeAuditSchema>;

// `prx triage promote` (GH-936) — promote.ts:128-141.
export const promoteAuditSchema = z.object({
  ts: z.string(),
  issue: z.number().int().positive(),
  url: z.string(),
  action: z.enum(["create", "skip", "partial-error", "error"]),
  decision: promoteDecisionSchema,
  type: typeLabelSchema.optional(),
  priority: priorityLabelSchema.optional(),
  beadId: z.string().optional(),
  actor: actorLiteralSchema,
  dryRun: z.boolean(),
  exitCode: z.number().int(),
  stderr: z.string().optional(),
});
export type PromoteAudit = z.infer<typeof promoteAuditSchema>;

// GH-1021 — type-pass audit row (forward-declared per ticket body).
export const typePassAuditRowSchema = z.object({
  ts: z.string(),
  issue: z.number().int().positive(),
  url: z.string(),
  title: z.string(),
  currentLabels: z.array(z.string()),
  decisionType: typeLabelSchema.optional(),
  confidence: z.enum(["high", "medium", "low"]).optional(),
  model: z.string(),
  batchId: z.string(),
  cost: z.number().nonnegative().optional(),
  actor: actorLiteralSchema,
  dryRun: z.boolean(),
  exitCode: z.number().int(),
  stderr: z.string().optional(),
});
export type TypePassAuditRow = z.infer<typeof typePassAuditRowSchema>;

export const typePassAuditSyncSchema = z.object({
  ts: z.string(),
  action: z.literal("sync"),
  touchedIssues: z.array(z.number().int().positive()),
  actor: actorLiteralSchema,
  dryRun: z.literal(false),
  bdExitCode: z.number().int(),
  bdStdout: z.string(),
  bdStderr: z.string().optional(),
});
export type TypePassAuditSync = z.infer<typeof typePassAuditSyncSchema>;

export const typePassAuditSchema = z.union([typePassAuditRowSchema, typePassAuditSyncSchema]);
export type TypePassAudit = z.infer<typeof typePassAuditSchema>;

// GH-1047 — prioritize-bulk audit row (forward-declared per ticket body).
export const prioritizeBulkAuditRowSchema = z.object({
  ts: z.string(),
  issue: z.number().int().positive(),
  url: z.string(),
  title: z.string(),
  currentLabels: z.array(z.string()),
  decision: z.enum(["critical", "high", "medium", "low"]).optional(),
  confidence: z.enum(["high", "medium", "low"]).optional(),
  model: z.string(),
  batchId: z.string(),
  cost: z.number().nonnegative().optional(),
  // GH-1384 provenance: the `scout://sha256:<hex>` CAS handle of the
  // content-addressed candidate batch this decision was inferred from. The
  // orchestrator writes the batch to the scout domain and re-reads it before
  // dispatch, so this handle attests the exact bytes the classifier saw.
  casHandle: z.string().optional(),
  actor: actorLiteralSchema,
  dryRun: z.boolean(),
  exitCode: z.number().int(),
  stderr: z.string().optional(),
});
export type PrioritizeBulkAuditRow = z.infer<typeof prioritizeBulkAuditRowSchema>;

// GH-1598 — `prx beads publish` audit row (one row per terminal outcome).
// ADR §4's "single record only" bd→GH publish chokepoint. No `--sync`
// sibling — ADR §3a's periodic job (GH-1537) owns the pull direction.
export const beadsPublishAuditRowSchema = z.object({
  ts: z.string(),
  bdId: z.string(),
  // GH-2382: `reconciled` — a linked record whose bd-authoritative fields
  // drifted from GH was reconciled losslessly (the old silent-noop bug).
  outcome: z.enum(["noop", "reconciled", "linked", "adopted", "created", "partial-error", "error"]),
  ghNumber: z.number().int().positive().optional(),
  ghUrl: z.string().optional(),
  actor: actorLiteralSchema,
  dryRun: z.boolean(),
  exitCode: z.number().int(),
  stderr: z.string().optional(),
});
export type BeadsPublishAuditRow = z.infer<typeof beadsPublishAuditRowSchema>;

// GH-1049 / GH-1115 — drift-fix audit row. Mirrors `DriftFixAuditRowEntry`
// in src/triage/drift-fix.ts (the verb owns the TS authority).
export const driftFixAuditRowSchema = z.object({
  ts: z.string(),
  issue: z.number().int().positive(),
  beadsId: z.string(),
  action: z.enum(["update", "skip", "error"]),
  decision: z.string(),
  axesFixed: z.array(z.enum(["type", "priority", "status"])).optional(),
  beforeAfter: z
    .object({
      type: z
        .object({ before: z.string(), after: z.string() })
        .optional(),
      priority: z
        .object({ before: z.string(), after: z.string() })
        .optional(),
      status: z
        .object({ before: z.literal("closed"), after: z.literal("open") })
        .optional(),
    })
    .optional(),
  actor: actorLiteralSchema,
  dryRun: z.boolean(),
  exitCode: z.number().int(),
  stderr: z.string().optional(),
});
export type DriftFixAuditRow = z.infer<typeof driftFixAuditRowSchema>;

// GH-1403 — drift-fix bd github sync chain row.
export const driftFixAuditSyncSchema = z.object({
  ts: z.string(),
  action: z.literal("sync"),
  touchedIssues: z.array(z.number().int().positive()),
  actor: actorLiteralSchema,
  dryRun: z.literal(false),
  bdExitCode: z.number().int(),
  bdStdout: z.string(),
  bdStderr: z.string().optional(),
});
export type DriftFixAuditSync = z.infer<typeof driftFixAuditSyncSchema>;

// GH-1255 — drift-fix dupe-cluster detection row. One row per (target, source)
// pair surfaced by `bd duplicates --dry-run`, recording the parity-gate
// decision regardless of whether a merge was attempted. `applied` is always
// false on this row; the follow-up `dupe-merge` row records execution.
export const driftFixDupeDetectedAuditRowSchema = z.object({
  ts: z.string(),
  action: z.literal("dupe-detected"),
  beadsTarget: z.string(),
  beadsSource: z.string(),
  parityOk: z.boolean(),
  parityReason: z.string().nullable(),
  actor: actorLiteralSchema,
  dryRun: z.boolean(),
  exitCode: z.number().int(),
});
export type DriftFixDupeDetectedAuditRow = z.infer<
  typeof driftFixDupeDetectedAuditRowSchema
>;

// GH-1255 — drift-fix dupe-cluster merge row. One row per (target, source)
// merge proposal: `applied=false` for parity-mismatch or dry-run; `applied=
// true` after a successful `bd merge` exec.
export const driftFixDupeMergeAuditRowSchema = z.object({
  ts: z.string(),
  action: z.literal("dupe-merge"),
  beadsTarget: z.string(),
  beadsSource: z.string(),
  parityOk: z.boolean(),
  applied: z.boolean(),
  actor: actorLiteralSchema,
  dryRun: z.boolean(),
  exitCode: z.number().int(),
  reason: z.string().optional(),
  stderr: z.string().optional(),
});
export type DriftFixDupeMergeAuditRow = z.infer<
  typeof driftFixDupeMergeAuditRowSchema
>;

// GH-1255 — drift-fix substrate-health row. One row per `bd doctor` surface
// (read-only by default). A second row with `applied=true` is emitted when
// `--doctor-fix` runs and a non-zero `fixable` count was present.
export const driftFixDoctorAuditRowSchema = z.object({
  ts: z.string(),
  action: z.literal("doctor-health"),
  total: z.number().int().nonnegative(),
  fixable: z.number().int().nonnegative(),
  applied: z.boolean(),
  issues: z
    .array(
      z.object({
        category: z.string(),
        count: z.number().int().nonnegative(),
        fixable: z.boolean(),
      }),
    )
    .default([]),
  actor: actorLiteralSchema,
  dryRun: z.boolean(),
  exitCode: z.number().int(),
  stderr: z.string().optional(),
});
export type DriftFixDoctorAuditRow = z.infer<typeof driftFixDoctorAuditRowSchema>;

export const driftFixAuditSchema = z.union([
  driftFixAuditRowSchema,
  driftFixAuditSyncSchema,
  driftFixDupeDetectedAuditRowSchema,
  driftFixDupeMergeAuditRowSchema,
  driftFixDoctorAuditRowSchema,
]);
export type DriftFixAudit = z.infer<typeof driftFixAuditSchema>;

// GH-1782 — `prx triage close-stale` audit row. Mirrors the drift-fix row spine
// (`ts/issue/beadsId/action/actor/dryRun/exitCode/stderr`) and adds
// close-stale specifics (`reason`, `url`, `note`). No sync chain — close-stale
// is bd-only-write; the GH side is already closed.
export const triageCloseStaleAuditRowSchema = z.object({
  ts: z.string(),
  issue: z.number().int().positive(),
  beadsId: z.string(),
  action: z.enum(["update", "skip", "error"]),
  reason: z.enum(["completed", "not-planned", "duplicate"]),
  url: z.string(),
  note: z.string(),
  actor: actorLiteralSchema,
  dryRun: z.boolean(),
  exitCode: z.number().int(),
  stderr: z.string().optional(),
});
export type TriageCloseStaleAuditRow = z.infer<typeof triageCloseStaleAuditRowSchema>;

// GH-1508 — `prx doctor dedupe-bd` audit row. One row per planned or applied
// action on a duplicate-record cluster (close, dep-edge re-anchor) or per
// surfaced conflict (both records carry execution state — §6 abort). Shares
// the close-stale row spine (`ts/beadsId/action/actor/dryRun/exitCode/stderr`)
// and adds dedupe-specific fields. `issue` is intentionally optional — pin-
// domain clusters need not be GH-anchored (a Notion-pinned dupe is still in
// scope; `domain`/`externalId` carry the pin identity instead).
export const doctorDedupeBdAuditRowSchema = z.object({
  ts: z.string(),
  domain: z.string(),
  externalId: z.string(),
  canonicalId: z.string().nullable(),
  beadsId: z.string(),
  action: z.enum(["close", "dep-rm", "dep-add", "conflict", "skip", "error"]),
  edgeType: z.string().optional(),
  edgeFrom: z.string().optional(),
  edgeTo: z.string().optional(),
  note: z.string().optional(),
  conflictReason: z.string().optional(),
  actor: actorLiteralSchema,
  dryRun: z.boolean(),
  exitCode: z.number().int(),
  stderr: z.string().optional(),
});
export type DoctorDedupeBdAuditRow = z.infer<typeof doctorDedupeBdAuditRowSchema>;

// GH-1059 — migrate-axis-value rows. Mirrors the TS type in
// src/triage/migrate-axis-value.ts; lifted here so the boundary parser can
// validate it as a member of `auditRowSchema`.
export const migrateAxisValueAuditRowSchema = z.object({
  ts: z.string(),
  issue: z.number().int().positive(),
  url: z.string(),
  axis: z.string(),
  from: z.string(),
  to: z.string(),
  action: z.enum(["edit", "skip", "partial-error", "error"]),
  prev: z.array(z.string()),
  actor: actorLiteralSchema,
  dryRun: z.boolean(),
  exitCode: z.number().int(),
  stderr: z.string().optional(),
});
export type MigrateAxisValueAuditRow = z.infer<typeof migrateAxisValueAuditRowSchema>;

export const migrateAxisValueAuditSyncSchema = z.object({
  ts: z.string(),
  action: z.literal("sync"),
  touchedIssues: z.array(z.number().int().positive()),
  actor: actorLiteralSchema,
  dryRun: z.literal(false),
  bdExitCode: z.number().int(),
  bdStdout: z.string(),
  bdStderr: z.string().optional(),
});
export type MigrateAxisValueAuditSync = z.infer<typeof migrateAxisValueAuditSyncSchema>;

export const migrateAxisValueAuditSchema = z.union([
  migrateAxisValueAuditRowSchema,
  migrateAxisValueAuditSyncSchema,
]);
export type MigrateAxisValueAudit = z.infer<typeof migrateAxisValueAuditSchema>;

// GH-1403 — machine state-transition events. One row per state entry, exit,
// or synthetic dispatch (sessionEntry → final-state profile build). Used by
// the XState `inspect` callback wired in `src/triage/prime.ts` and
// `src/pr-state/session-entry/dispatch.ts`. `actor` is broader than the
// per-verb `claude-code` literal because the inspector runs under the live
// process identity (test harness, prx CLI, or the claude-code session).
export const machineEventAuditSchema = z.object({
  ts: z.string(),
  // GH-360: `pilot`/`fleet` so the autonomous machines' own state transitions
  // are valid audit rows (the monitor already greps machine:pilot).
  machine: z.enum(["triage", "session-entry", "pilot", "fleet"]),
  kind: z.enum(["entry", "exit", "dispatch"]),
  workUnitId: z.string().optional(),
  state: z.string(),
  event: z.string().optional(),
  prevState: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  profile: z.string().optional(),
  actor: z.string(),
});
export type MachineEventAudit = z.infer<typeof machineEventAuditSchema>;

// GH-1537 — `prx beads sync` rows (the GH-1500 authority ADR §3a periodic
// beads↔external-domain reconcile job, src/sync/run.ts). One `domain-sync-run`
// summary row per tick, plus an optional `domain-sync-pair` row per pair that
// changed something (closed or pushed) or failed — mirrors the `triage apply`
// per-issue + chain-row pattern. `actor` is `z.string()` (not the per-verb
// `claude-code` literal) because a cron/launchd tick runs under a different
// identity (see `machineEventAuditSchema` for the same reasoning).
export const domainSyncRunAuditSchema = z.object({
  ts: z.string(),
  kind: z.literal("domain-sync-run"),
  repo: z.string(),
  domain: z.string(),
  scanned: z.number().int().nonnegative(),
  pinned: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  pulled: z.number().int().nonnegative(),
  pushed: z.number().int().nonnegative(),
  closedByPull: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  // GH-2095 — split breakdown of `failed` / `deferred`. `pullFailed` is the
  // pull-leg error count; `pullDeferred` is pairs skipped by mid-loop budget
  // exhaustion; `pushDeferred` is pairs whose pull leg ran (and close-applied
  // if needed) but whose push leg was capped by `--limit` or the push-phase
  // budget gate. `deferred = pullDeferred + pushDeferred` is preserved as the
  // back-compat sum for existing consumers.
  pullFailed: z.number().int().nonnegative(),
  pullDeferred: z.number().int().nonnegative(),
  pushDeferred: z.number().int().nonnegative(),
  deferred: z.number().int().nonnegative(),
  budgetPaused: z.boolean(),
  dryRun: z.boolean(),
  durationMs: z.number().nonnegative(),
  actor: z.string(),
});
export type DomainSyncRunAuditRow = z.infer<typeof domainSyncRunAuditSchema>;

export const domainSyncPairAuditSchema = z.object({
  ts: z.string(),
  kind: z.literal("domain-sync-pair"),
  // GH-1662: tag per-pair rows with the OWNER/REPO they reconciled against so
  // a cross-repo daemon tick's NDJSON output is filterable per-repo (the
  // summary row already carries `repo`).
  repo: z.string(),
  domain: z.string(),
  beadId: z.string(),
  externalId: z.string(),
  externalStatus: z.string(),
  closedByPull: z.boolean(),
  pushed: z.boolean(),
  action: z.enum(["synced", "failed"]),
  message: z.string().optional(),
  dryRun: z.boolean(),
  actor: z.string(),
});
export type DomainSyncPairAuditRow = z.infer<typeof domainSyncPairAuditSchema>;

// GH-1662 — cross-repo daemon (`prx beads sync --all-repos`) skip-on-failure
// audit row. Emitted when `materializeBareRepo()` throws for a repo in the
// inventory: the orchestrator records the failure, advances the cursor past
// the failed repo, and continues. No per-pair rows follow.
export const domainSyncMaterializeFailedSchema = z.object({
  ts: z.string(),
  kind: z.literal("domain-sync-materialize-failed"),
  repo: z.string(),
  error: z.string(),
  actor: z.string(),
  dryRun: z.boolean(),
});
export type DomainSyncMaterializeFailedRow = z.infer<typeof domainSyncMaterializeFailedSchema>;

// GH-1469 — `prx sync backfill` rows. One `domain-sync-backfill-run` summary
// per invocation, plus a `domain-sync-backfill-record` row per enumerated
// external record. Mirrors the `domain-sync-run` / `domain-sync-pair` shape;
// `actor` is `z.string()` for the same reason (the verb may run under a
// cron/launchd identity). Every row carries `uow_id` so the audit substrate's
// uow_id requirement holds (I-BF6, grounds I-AUD1).
export const domainSyncBackfillRunAuditSchema = z.object({
  ts: z.string(),
  kind: z.literal("domain-sync-backfill-run"),
  repo: z.string(),
  domain: z.string(),
  from: z.number().int(),
  to: z.number().int(),
  scanned: z.number().int().nonnegative(),
  mirrored: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  deferred: z.number().int().nonnegative(),
  budgetPaused: z.boolean(),
  dryRun: z.boolean(),
  durationMs: z.number().nonnegative(),
  uow_id: z.string(),
  actor: z.string(),
});
export type DomainSyncBackfillRunAuditRow = z.infer<typeof domainSyncBackfillRunAuditSchema>;

export const domainSyncBackfillRecordAuditSchema = z.object({
  ts: z.string(),
  kind: z.literal("domain-sync-backfill-record"),
  repo: z.string(),
  domain: z.string(),
  externalId: z.string(),
  surfaceId: z.string(),
  action: z.enum(["mirrored", "skipped", "failed"]),
  bdId: z.string().optional(),
  message: z.string().optional(),
  dryRun: z.boolean(),
  uow_id: z.string(),
  actor: z.string(),
});
export type DomainSyncBackfillRecordAuditRow = z.infer<typeof domainSyncBackfillRecordAuditSchema>;

export const domainSyncAuditSchema = z.union([
  domainSyncRunAuditSchema,
  domainSyncPairAuditSchema,
  domainSyncMaterializeFailedSchema,
  domainSyncBackfillRunAuditSchema,
  domainSyncBackfillRecordAuditSchema,
]);
export type DomainSyncAudit = z.infer<typeof domainSyncAuditSchema>;

// GH-1513 — `prx memory compact` rows. The bd-side memory-decay policy
// chokepoint (GH-1500 ADR §3b). One `memory-compact-run` summary row per
// invocation, plus an optional `memory-compact-record` row per classified
// candidate. Mirrors the `domain-sync-run` + `domain-sync-pair` shape for
// the same audit-trail consumers. `actor` is `z.string()` (not the per-verb
// `claude-code` literal) because the verb is operator-triggered and may run
// under a cron/launchd identity in the future.
export const memoryCompactRunAuditSchema = z.object({
  ts: z.string(),
  kind: z.literal("memory-compact-run"),
  repo: z.string(),
  scanned: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
  eligible: z.number().int().nonnegative(),
  compacted: z.number().int().nonnegative(),
  preservedByMarker: z.number().int().nonnegative(),
  preservedByType: z.number().int().nonnegative(),
  preservedByActiveWork: z.number().int().nonnegative(),
  underHorizon: z.number().int().nonnegative(),
  deferred: z.number().int().nonnegative(),
  dryRun: z.boolean(),
  durationMs: z.number().nonnegative(),
  actor: z.string(),
});
export type MemoryCompactRunAuditRow = z.infer<typeof memoryCompactRunAuditSchema>;

export const memoryCompactRecordAuditSchema = z.object({
  ts: z.string(),
  kind: z.literal("memory-compact-record"),
  beadId: z.string(),
  issueType: z.string(),
  ageDays: z.number().nonnegative(),
  decision: z.enum([
    "compacted",
    "preserved-marker",
    "preserved-type",
    "preserved-active-work",
    "under-horizon",
    "deferred",
  ]),
  reason: z.string().optional(),
  dryRun: z.boolean(),
  actor: z.string(),
});
export type MemoryCompactRecordAuditRow = z.infer<typeof memoryCompactRecordAuditSchema>;

export const memoryCompactAuditSchema = z.union([
  memoryCompactRunAuditSchema,
  memoryCompactRecordAuditSchema,
]);
export type MemoryCompactAudit = z.infer<typeof memoryCompactAuditSchema>;

// GH-1616 — actor-catalog observability rows. One row per catalog event
// recorded outside the XState `inspect` path (e.g., picker cache-lifecycle
// events from `nextWork()`). The `event` field is the catalog event name
// declared in `eventOwnerMap`; `actor` is its owning actor. `details` is
// kept open-shaped so per-event payloads don't require a per-event arm —
// the trust boundary is the event/owner pair, not the payload structure.
export const catalogEventAuditSchema = z.object({
  ts: z.string(),
  kind: z.literal("catalog-event"),
  event: z.string(),
  actor: z.string(),
  workUnitId: z.string().optional(),
  repo: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type CatalogEventAuditRow = z.infer<typeof catalogEventAuditSchema>;

// GH-1722 — `prx repo backfill` rows. One entry row per inventory entry
// scanned (mirrors `domain-sync-pair`), one run-row summarizing the pass
// (mirrors `domain-sync-run`). `actor` is `z.string()` because the verb is
// operator-triggered and may also run under a daemon identity in the future.
//
// `source` captures *how* the prefix was derived:
//   - "bd-config":   read from `bd config get database.workspace_prefix` in
//                    the materialized mainx worktree (`.beads/` present).
//   - "name-derived": kebab fallback from `repo.name` because `bd` couldn't
//                    resolve a prefix (no `.beads/` in HEAD or hydration
//                    skipped). Operator follow-up via `prx repo refresh
//                    <slug>` (GH-1681) when DoltHub setup is needed.
//   - "preexisting": entry already had a `bd_workspace_prefix` on read.
export const repoBackfillEntryAuditSchema = z.object({
  ts: z.string(),
  kind: z.literal("repo-backfill-entry"),
  slug: z.string(),
  commonDir: z.string(),
  bdWorkspacePrefix: z.string().optional(),
  source: z.enum(["bd-config", "name-derived", "preexisting"]).optional(),
  action: z.enum(["set", "skipped", "failed"]),
  reason: z.string().optional(),
  materializedMainx: z.boolean(),
  hydrated: z.boolean(),
  // Derivable DoltHub remote URL for bd-missing entries — surfaced so the
  // audit-NDJSON consumer can reproduce the operator-facing bootstrap hint
  // without re-running URL synthesis.
  doltRemote: z.string().optional(),
  dryRun: z.boolean(),
  actor: z.string(),
});
export type RepoBackfillEntryAuditRow = z.infer<typeof repoBackfillEntryAuditSchema>;

export const repoBackfillRunAuditSchema = z.object({
  ts: z.string(),
  kind: z.literal("repo-backfill-run"),
  scanned: z.number().int().nonnegative(),
  populated: z.number().int().nonnegative(),
  alreadySet: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  // `bdMissing` counts entries the verb populated via the name-derived
  // fallback — i.e. ones the operator should follow up on with `prx repo
  // refresh <slug>` to land a true bd-config prefix.
  bdMissing: z.number().int().nonnegative(),
  dryRun: z.boolean(),
  durationMs: z.number().nonnegative(),
  actor: z.string(),
});
export type RepoBackfillRunAuditRow = z.infer<typeof repoBackfillRunAuditSchema>;

export const repoBackfillAuditSchema = z.union([
  repoBackfillEntryAuditSchema,
  repoBackfillRunAuditSchema,
]);
export type RepoBackfillAudit = z.infer<typeof repoBackfillAuditSchema>;

// GH-1700 — `prx repo gc` rows. One entry row per inventory entry scanned plus
// one run row summarizing the pass. `apply=false` is the dry-run plan; refusal
// reasons gate mutation per the GC-I1..I3 invariants.
export const REPO_GC_REFUSAL_REASONS = [
  "not-migrated",
  "server-unreachable",
  "db-empty",
  "no-such-slug",
  "nothing-to-clean",
] as const;
export type RepoGcRefusalReason = (typeof REPO_GC_REFUSAL_REASONS)[number];

export const repoGcEntryAuditSchema = z.object({
  ts: z.string(),
  kind: z.literal("repo-gc-entry"),
  slug: z.string(),
  commonDir: z.string(),
  workspacePath: z.string(),
  classification: z.enum([
    "none",
    "embedded",
    "per_project",
    "shared_server",
    "ambiguous",
  ]),
  orphanPath: z.string().nullable(),
  orphanBytes: z.number().int().nonnegative().nullable(),
  action: z.enum(["swept", "would-sweep", "refused", "nothing-to-clean"]),
  refusalReason: z.enum(REPO_GC_REFUSAL_REASONS).optional(),
  apply: z.boolean(),
  actor: z.string(),
});
export type RepoGcEntryAuditRow = z.infer<typeof repoGcEntryAuditSchema>;

export const repoGcRunAuditSchema = z.object({
  ts: z.string(),
  kind: z.literal("repo-gc-run"),
  scanned: z.number().int().nonnegative(),
  orphansFound: z.number().int().nonnegative(),
  swept: z.number().int().nonnegative(),
  refused: z.number().int().nonnegative(),
  cleanedBytes: z.number().int().nonnegative(),
  apply: z.boolean(),
  durationMs: z.number().nonnegative(),
  actor: z.string(),
});
export type RepoGcRunAuditRow = z.infer<typeof repoGcRunAuditSchema>;

export const repoGcAuditSchema = z.union([
  repoGcEntryAuditSchema,
  repoGcRunAuditSchema,
]);
export type RepoGcAudit = z.infer<typeof repoGcAuditSchema>;

// GH-867 — one row per `migrateLegacyNotionCache` call that actually moved
// files out of `.prx/notion-cache/`. Emitted from session-entry dispatch on
// the first session-open in a worktree that still has the legacy dir; subsequent
// runs no-op because the dir has been removed.
export const notionCacheMigratedAuditSchema = z.object({
  ts: z.string(),
  kind: z.literal("notion-cache-migrated"),
  count: z.number().int().nonnegative(),
  targetDir: z.string(),
  actor: z.string(),
});
export type NotionCacheMigratedAuditRow = z.infer<
  typeof notionCacheMigratedAuditSchema
>;

// GH-1828 — non-interactive Claude agent lifecycle. Emitted by the SDK
// service (`src/claude/agent_service.ts`) for every plan-print, triage Haiku
// classifier, Notion preflight, and agent-doctor probe run. Five subkinds
// span the lifecycle: STARTED → (USAGE) → COMPLETED | CANCELLED | FAILED.
// Token-level stream events stay in-process (see NonInteractiveStreamEvent);
// the audit sink captures only the durable signals.
export const nonInteractiveAgentAuditSchema = z.union([
  z.object({
    ts: z.string(),
    kind: z.literal("non-interactive-agent"),
    subkind: z.literal("started"),
    workUnitId: z.string().optional(),
    role: z.string().optional(),
    profile: z.string(),
    model: z.string().optional(),
    actor: z.string(),
    // GH-1407 — `true` when --no-cache invalidated the cache prefix via the
    // SDK service nonce; absent on the warm path.
    cache_disabled: z.boolean().optional(),
  }),
  z.object({
    ts: z.string(),
    kind: z.literal("non-interactive-agent"),
    subkind: z.literal("usage"),
    workUnitId: z.string().optional(),
    // GH-1407 — duplicated from the `started` row so the
    // `prx services status --anthropic` projector can group by profile /
    // model without joining across rows.
    profile: z.string().optional(),
    model: z.string().optional(),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_creation_input_tokens: z.number().int().nonnegative(),
    cache_read_input_tokens: z.number().int().nonnegative(),
    latency_ms: z.number().int().nonnegative(),
    total_cost_usd: z.number().nonnegative().optional(),
    actor: z.string(),
    cache_disabled: z.boolean().optional(),
  }),
  z.object({
    ts: z.string(),
    kind: z.literal("non-interactive-agent"),
    subkind: z.literal("cancelled"),
    workUnitId: z.string().optional(),
    reason: z.enum(["watchdog", "operator"]),
    elapsed_ms: z.number().int().nonnegative(),
    configured_timeout_ms: z.number().int().nonnegative().nullable(),
    draft_ref: z.string().nullable(),
    actor: z.string(),
  }),
  z.object({
    ts: z.string(),
    kind: z.literal("non-interactive-agent"),
    subkind: z.literal("failed"),
    workUnitId: z.string().optional(),
    error_kind: z.enum(["rate_limit", "network", "model", "cancelled"]),
    elapsed_ms: z.number().int().nonnegative(),
    message: z.string().optional(),
    actor: z.string(),
  }),
  z.object({
    ts: z.string(),
    kind: z.literal("non-interactive-agent"),
    subkind: z.literal("completed"),
    workUnitId: z.string().optional(),
    status: z.literal("success"),
    output_hash: z.string(),
    elapsed_ms: z.number().int().nonnegative(),
    actor: z.string(),
  }),
]);
export type NonInteractiveAgentAuditRow = z.infer<typeof nonInteractiveAgentAuditSchema>;

// GH-1403 — unified audit-row union. All per-verb rows plus the machine
// state-transition row. `appendAuditRow` validates against this at the
// runtime sink boundary (per `reference_zod_boundary_layer`).
export const auditRowSchema = z.union([
  applyAuditSchema,
  prioritizeAuditSchema,
  promoteAuditSchema,
  typePassAuditSchema,
  prioritizeBulkAuditRowSchema,
  beadsPublishAuditRowSchema,
  driftFixAuditSchema,
  triageCloseStaleAuditRowSchema,
  doctorDedupeBdAuditRowSchema,
  migrateAxisValueAuditSchema,
  promoteChildrenAuditEntrySchema,
  machineEventAuditSchema,
  domainSyncRunAuditSchema,
  domainSyncPairAuditSchema,
  domainSyncMaterializeFailedSchema,
  domainSyncBackfillRunAuditSchema,
  domainSyncBackfillRecordAuditSchema,
  memoryCompactRunAuditSchema,
  memoryCompactRecordAuditSchema,
  catalogEventAuditSchema,
  repoBackfillEntryAuditSchema,
  repoBackfillRunAuditSchema,
  repoGcEntryAuditSchema,
  repoGcRunAuditSchema,
  notionCacheMigratedAuditSchema,
  nonInteractiveAgentAuditSchema,
]);
export type AuditRow = z.infer<typeof auditRowSchema>;
