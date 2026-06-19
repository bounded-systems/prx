// GH-1822 — Zod schemas for the 4 lifecycle-axis success-criteria artifacts.
//
// `statusUpdate`, `blockerReport`, `delegationRecord`, and `sprintPlan` are
// the four artifacts whose live shape the issue body of GH-1822 commits to.
// Together they satisfy the Scrum-fit lifecycle invariant:
//
//   - StatusUpdate references at least one UoW; free-floating prose is rejected.
//   - BlockerReport carries owner + unblock_condition + severity, not just text.
//   - DelegationRecord is a typed artifact (the slot `prx delegate` writes to).
//   - Sprint membership is queryable from the UoW graph: a SprintPlan carries
//     `selected_uow_ids`, and reverse edges over those ids materialize the
//     "what's in this sprint" view without a separate sprint-truth store.
//
// I-UOW1: every registered artifact carries a `uow_id` field whose value
// resolves to a UoW in the artifact graph, or carries a non-empty
// `aggregate_uow_id` field referencing a UoW whose kind ∈ {epic, sprint,
// release, spike}. The four schemas below name those refs explicitly:
//
//   - statusUpdate    : uow_refs[0..n] (n ≥ 1)         — explicit UoW lineage
//   - blockerReport   : unitId (single UoW)            — explicit UoW lineage
//   - delegationRecord: unitId (single UoW)            — explicit UoW lineage
//   - sprintPlan      : sprint_uow_id (aggregate UoW)  — explicit aggregate ref
//
// The audit-store predicates `assertUowAttachment` / `assertArtifactLineage`
// (`src/audit/invariants.ts`) are the operational form of I-UOW1; this module
// is the schema-level form for the four live slots.

import { z } from "zod";

import { artifactTypeNames } from "../../audit/artifact-types.ts";

// ── shared atoms ──────────────────────────────────────────────────────────

const isoTimestampSchema = z
  .string()
  .min(1)
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
    "expected ISO-8601 timestamp",
  );

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD calendar date");

// UoW ids in this project today are GH-NNN (issue-rooted units). The schemas
// accept any non-empty string so cross-repo (`<repo>#NNN`) and beads
// (`bd-...`) UoWs validate against the same slot.
const uowIdSchema = z.string().min(1, "uow id must be non-empty");

// Artifact-type ids are the canonical names committed in
// `src/audit/artifact-types.ts`. `expected_output_type` on a DelegationRecord
// points at one of these slots, so `prx delegate` records the typed artifact
// the delegated work is expected to produce.
const artifactTypeIdSchema = z.enum(artifactTypeNames);

const blockerSeveritySchema = z.enum(["low", "med", "high", "critical"]);

// ── uow (unit of work) ────────────────────────────────────────────────────
//
// The pipeline's ROOT artifact: intake's output and triage's input
// (`sessionProfileIo`: intake → uow / triage: uow_queue → …). prx-4fa fills the
// previously-deferred `prx.uow.v1` contract (GH-1824) with a concrete schema so
// the intake→triage boundary is typed. A uow is persisted in git (the GH issue /
// bead), NOT the CAS — so its transport is GH/beads, not the `pipeline/edge.ts`
// CAS primitive (which serves the cas-persisted back-half: plan→implement→…).
// Its `id` IS the uow id every other artifact's I-UOW1 lineage hangs off — a uow
// anchors itself. Required fields mirror the registry contract (`id/title/status`).
export const uowStatusSchema = z.enum(["open", "in_progress", "blocked", "closed"]);
export type UowStatus = z.infer<typeof uowStatusSchema>;

export const uowSchema = z
  .object({
    // GH-NNN / <repo>#NNN / bd-… — the work-unit identity + I-UOW1 anchor.
    id: uowIdSchema,
    title: z.string().min(1, "uow.title must be non-empty"),
    status: uowStatusSchema,
  })
  .strict();
export type Uow = z.infer<typeof uowSchema>;

// ── statusUpdate ──────────────────────────────────────────────────────────

export const statusUpdateSchema = z
  .object({
    // The UoW the update is attached to. Mirrors `unitId` on the existing
    // audit-store slot (`src/audit/artifact-types.ts:138`).
    unitId: uowIdSchema,
    // Required ≥ 1: StatusUpdate must reference at least one UoW. Free-
    // floating prose ("everyone is busy") is rejected at the schema layer.
    uow_refs: z.array(uowIdSchema).min(1, "statusUpdate must reference at least one UoW"),
    body: z.string().min(1, "statusUpdate.body must be non-empty"),
    author: z.string().min(1, "statusUpdate.author must be non-empty"),
    ts: isoTimestampSchema,
  })
  .strict();

export type StatusUpdate = z.infer<typeof statusUpdateSchema>;

// ── blockerReport ─────────────────────────────────────────────────────────

export const blockerReportSchema = z
  .object({
    unitId: uowIdSchema,
    // The owner the blocker is assigned to — not just narrative text. The
    // GH-1822 issue body's hard-fail: "carries owner + unblock_condition +
    // severity, not just text".
    owner: z.string().min(1, "blockerReport.owner must be non-empty"),
    unblock_condition: z.string().min(1, "blockerReport.unblock_condition must be non-empty"),
    severity: blockerSeveritySchema,
    reason: z.string().min(1, "blockerReport.reason must be non-empty"),
  })
  .strict();

export type BlockerReport = z.infer<typeof blockerReportSchema>;

// ── delegationRecord ──────────────────────────────────────────────────────

export const delegationRecordSchema = z
  .object({
    unitId: uowIdSchema,
    assigned_to: z.string().min(1, "delegationRecord.assigned_to must be non-empty"),
    // The typed artifact the delegated work is expected to produce. Pinning
    // this to `artifactTypeNames` keeps `prx delegate` writes typed end to
    // end: the delegate emits a DelegationRecord, the delegatee emits an
    // artifact of the named type, and the audit chain links them.
    expected_output_type: artifactTypeIdSchema,
    capabilities: z.array(z.string().min(1)),
    deadline: isoTimestampSchema.optional(),
    delegated_by: z.string().min(1, "delegationRecord.delegated_by must be non-empty"),
  })
  .strict();

export type DelegationRecord = z.infer<typeof delegationRecordSchema>;

// ── sprintPlan ────────────────────────────────────────────────────────────

export const sprintPlanSchema = z
  .object({
    // The aggregate UoW (kind=sprint) the plan materializes. Sprint
    // membership is then a pure query over the artifact graph
    // (`sprint_plan.selected_uow_ids` reverse edges).
    sprint_uow_id: uowIdSchema,
    selected_uow_ids: z.array(uowIdSchema).min(1, "sprintPlan must select at least one UoW"),
    // Optional capacity hint (story points, hours, units — units are up to
    // the operator). Kept open: this spike does not commit to a unit.
    capacity: z.number().nonnegative().optional(),
    start_date: isoDateSchema,
    end_date: isoDateSchema,
  })
  .strict()
  .refine((p) => p.start_date <= p.end_date, {
    message: "sprintPlan.start_date must be on or before end_date",
    path: ["end_date"],
  });

export type SprintPlan = z.infer<typeof sprintPlanSchema>;
