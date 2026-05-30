// Boundary schemas for the beads↔external-domain sync routine (GH-1537 — the
// GH-1500 authority ADR §3a periodic reconcile job).
//
// These Zod shapes lock the data contract for the per-pair `domainSyncMachine`
// (src/sync/machine.ts) and its `fromPromise` actors (src/sync/actors.ts):
// per pinned `(uow, domain)` pair, `pull` the external record and decide
// whether the bead needs closing, then `push` the bd-authoritative title/body
// onto the external record. Boundary-validation pattern matches
// src/dep-research/schemas.ts and src/triage/schemas/: scalar inputs/results
// are parsed via Zod at the seam; the full `BeadsRecord` rides through the
// machine input as an already-validated opaque (loadAllBeads validated it).

import { z } from "zod";

/** Per-pair pull-actor scalar input (the `BeadsRecord` rides on the machine input). */
export const domainSyncPullInputSchema = z.object({
  beadId: z.string().min(1),
  domain: z.string().min(1),
  /** External id the adapter exchanges — for `gh` this is the issue URL. */
  externalId: z.string().min(1),
  /** The bd record's status before the tick (e.g. `"open"` / `"closed"`). */
  beadStatus: z.string().min(1),
});
export type DomainSyncPullInput = z.infer<typeof domainSyncPullInputSchema>;

/** Per-pair push-actor scalar input. */
export const domainSyncPushInputSchema = z.object({
  beadId: z.string().min(1),
  domain: z.string().min(1),
  externalId: z.string().min(1),
  beadTitle: z.string(),
  beadBody: z.string().default(""),
  /**
   * GH-1874 — bd's singular `assignee` column projected onto the external
   * record. `null` means "bd has no assignee" → push() emits `assignees: []`
   * (clear). A populated string → push() emits `assignees: [assignee]` (the
   * GH adapter handles the add/remove diff against the live external state).
   * `undefined` would suppress projection (no-op); we always normalize to
   * null/string here so the periodic reconcile is the writer.
   */
  beadAssignee: z.string().nullable().default(null),
  /**
   * GH-2382 — the bd-axis GH labels (`type::*` / `priority::*`) to project,
   * derived by the run loop via `issueLabelsFor(bead)`. The adapter swaps the
   * managed axes losslessly against the live external labels so a bd priority
   * bump strips the stale rung. `[]` projects no axis labels (no managed-axis
   * read/edit). bd→external only (I-DS-PRIO): the live read never feeds a bd
   * write.
   */
  beadLabels: z.array(z.string()).default([]),
  /**
   * GH-2382 — the bd record's status, threaded for parity with the field set.
   * The push leg deliberately does NOT project status onto the external record
   * (status stays owned by the merge-close / `bulkClose` paths to avoid a
   * pull-vs-push close/reopen conflict); this is surfaced for audit/visibility
   * only and is not passed to `adapter.push`.
   */
  beadStatus: z.string().optional(),
  dryRun: z.boolean().default(false),
});
export type DomainSyncPushInput = z.infer<typeof domainSyncPushInputSchema>;

/**
 * Result of pulling one pair. `needsClose` is the only state-changing
 * decision this leg makes — the actual close write is batched by the run loop
 * through `adapter.bulkPull()` (`bd github sync --pull-only --prefer-github`),
 * the established + policy-allowed close path; `execBd` blocks `bd close`
 * directly. (`assignees` / `milestone` from the patch are not applied — no bd
 * home yet, GH-1538.)
 */
export const domainSyncPullResultSchema = z.object({
  beadId: z.string().min(1),
  externalId: z.string().min(1),
  /** Normalised external status: `"open"` / `"closed"` / `"unknown"`. */
  externalStatus: z.string().min(1),
  beadStatusBefore: z.string().min(1),
  needsClose: z.boolean(),
});
export type DomainSyncPullResult = z.infer<typeof domainSyncPullResultSchema>;

/** Result of pushing one pair. `edited` is false on dry-run (planned only). */
export const domainSyncPushResultSchema = z.object({
  beadId: z.string().min(1),
  externalId: z.string().min(1),
  edited: z.boolean(),
});
export type DomainSyncPushResult = z.infer<typeof domainSyncPushResultSchema>;

// GH-1469 — boundary schemas for `prx sync backfill` (range-backfill of
// cursor-skipped external records, GH-1500 authority ADR §5). One
// `BackfillRecordDetail` per enumerated external record, plus a
// `BackfillSummary` per run. Mirrors the `BeadsSyncSummary` /
// `BeadsSyncPairDetail` shape (src/sync/run.ts) so the `--format=json` output
// and audit projection consume a stable contract. Backfill never advances the
// fetch watermark or the `bd github sync` cursor (I-BF3).

export const backfillRecordDetailSchema = z.object({
  /** The external-id shape the domain exchanges — for `gh`, the issue URL. */
  externalId: z.string().min(1),
  /** The canonical surface id — for `gh`, `GH-<n>`. */
  surfaceId: z.string().min(1),
  /**
   * `mirrored` — was unmatched, a bd record was created (or planned on
   * `--dry-run`); `skipped` — already resolved to a bd record (idempotent
   * no-op, I-BF2); `failed` — the mirror attempt errored.
   */
  action: z.enum(["mirrored", "skipped", "failed"]),
  /** The resolved/created bd short-id, when known. */
  bdId: z.string().optional(),
  message: z.string().optional(),
});
export type BackfillRecordDetail = z.infer<typeof backfillRecordDetailSchema>;

export const backfillSummarySchema = z.object({
  repo: z.string(),
  domain: z.string(),
  from: z.number().int(),
  to: z.number().int(),
  /** External records enumerated in range. */
  scanned: z.number().int().nonnegative(),
  /** Unmatched records mirrored (or planned on `--dry-run`). */
  mirrored: z.number().int().nonnegative(),
  /** Records already resolved to a bd record (idempotent skip). */
  skipped: z.number().int().nonnegative(),
  /** Records whose mirror attempt errored. */
  failed: z.number().int().nonnegative(),
  /** Records not reached this run (mid-loop budget cutoff). */
  deferred: z.number().int().nonnegative(),
  /** True when the run exited early because the GraphQL budget fell below threshold. */
  budgetPaused: z.boolean(),
  dryRun: z.boolean(),
  durationMs: z.number().nonnegative(),
});
export type BackfillSummary = z.infer<typeof backfillSummarySchema>;

// GH-1702 — boundary schemas for the `prx beads sync-all` cross-repo
// fan-out. Locked here so the `--format=json` output and any future
// audit/`prx chain status` projection consume a stable contract.

export const doltReconcileStepSchema = z.object({
  step: z.enum(["commit", "pull", "push", "resolve-schema"]),
  status: z.enum(["ok", "skipped", "failed", "preview"]),
  exitCode: z.number().int(),
  stderrTail: z.string().optional(),
  command: z.string().min(1),
});
export type DoltReconcileStepBoundary = z.infer<typeof doltReconcileStepSchema>;

export const doltReconcileRepoResultSchema = z.object({
  slug: z.string().min(1),
  /** OWNER/REPO when present; null when the inventory has no primary remote. */
  nameWithOwner: z.string().nullable(),
  status: z.enum(["success", "no-op", "conflict", "failed", "skipped"]),
  /** Reason on `status === "skipped"`; absent otherwise. */
  skipReason: z.enum(["no-remote", "legacy-embedded"]).optional(),
  mode: z.enum(["full", "push-only", "pull-only"]),
  /** Present iff the per-repo reconcile actually ran (i.e. not skipped). */
  steps: z.array(doltReconcileStepSchema).optional(),
  hint: z.string().optional(),
  error: z.string().optional(),
});
export type DoltReconcileRepoResult = z.infer<typeof doltReconcileRepoResultSchema>;

export const doltReconcileAcrossReposResultSchema = z.object({
  perRepo: z.array(doltReconcileRepoResultSchema),
  exitCode: z.number().int().min(0),
  tickStartedAt: z.string().datetime(),
  /** Mode that ran across the fleet (mirrors per-repo `mode`). */
  mode: z.enum(["full", "push-only", "pull-only"]),
});
export type DoltReconcileAcrossReposResult = z.infer<typeof doltReconcileAcrossReposResultSchema>;
