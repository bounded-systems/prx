// GH-1821 — Artifact registry for the contract trinity.
//
// One ArtifactContract entry per artifact referenced by any AgentContract in
// `./instances.ts`, even when the validation schema lives behind a follow-up
// ticket. Live entries point at checked-in JSON schemas; deferred entries
// carry `validationRef: "deferred:GH-<n>"` so the trinity is complete from
// day one and follow-up shards know exactly where to fill in.
//
// Composite (curry-target) artifacts are listed last and carry `composedOf`
// pointing at the simpler artifacts they bundle.

import { artifactContractSchema, type ArtifactContract } from "../contracts.ts";

const live = (
  type: string,
  schemaVersion: string,
  validationRef: string,
  requiredFields: string[],
  persistence: ArtifactContract["persistence"],
): ArtifactContract =>
  artifactContractSchema.parse({
    type,
    schemaVersion,
    requiredFields,
    validationRef,
    persistence,
  });

const deferred = (
  type: string,
  schemaVersion: string,
  ticket: string,
  requiredFields: string[],
  persistence: ArtifactContract["persistence"],
): ArtifactContract =>
  artifactContractSchema.parse({
    type,
    schemaVersion,
    requiredFields,
    validationRef: `deferred:${ticket}`,
    persistence,
  });

const composite = (
  type: string,
  schemaVersion: string,
  composedOf: string[],
  ticket: string,
): ArtifactContract =>
  artifactContractSchema.parse({
    type,
    schemaVersion,
    requiredFields: [],
    validationRef: `deferred:${ticket}`,
    persistence: "cas",
    composedOf,
  });

// ── live (already-typed) artifacts ────────────────────────────────────────

const rawStateV1 = live(
  "raw_state_v1",
  "prx.raw_state_v1.v1",
  "schema:src/machine/state.ts#rawStateV1Schema",
  ["unitId", "artifacts", "signals", "sync", "meta"],
  "git",
);

const dispatchRequest = live(
  "dispatch_request",
  "prx.dispatch_request.v1",
  "schema:src/machine/dispatch.ts#dispatchRequestSchema",
  ["source", "target", "action", "args"],
  "cas",
);

const dispatchResult = live(
  "dispatch_result",
  "prx.dispatch_result.v1",
  "schema:src/machine/dispatch.ts#dispatchResultSchema",
  ["casHandle", "target", "exitCode", "durationMs"],
  "cas",
);

const runtimeOutput = live(
  "runtime_output",
  "prx.runtime_output.v1",
  "schema:src/machine/runtime_output.ts#buildRuntimeOutputSchema",
  [
    "workUnitId",
    "role",
    "phase",
    "status",
    "parityChain",
    "modelBoundary",
    "implementationPlan",
    "changes",
    "verification",
  ],
  "cas",
);

const deriveTransition = live(
  "derive_transition",
  "prx.derive_transition.v1",
  "schema:schemas/derive/transition.json",
  ["id", "issueId", "fromState", "toState", "actor", "timestamp"],
  "dolt",
);

// ── deferred placeholders ─────────────────────────────────────────────────
//
// Each entry below is a *registry* entry only — the Zod / JSON validation
// schema is intentionally out of scope per GH-1821's issue body ("out of
// scope: implementing every artifact schema"). The follow-up ticket on each
// entry is where that work lands.

// GH-1822: re-pointed away from this ticket (the GH-1822 spike landed a
// different surface — Scrum-fit lifecycle + UoW-rooted invariant — not the
// context_bundle schema GH-1821's deferred table claimed would live here).
// Follow-up ticket for the context_bundle Zod schema is GH-1836.
const contextBundle = deferred(
  "context_bundle",
  "prx.context_bundle.v1",
  "GH-1836",
  ["unitId", "facts", "openQuestions"],
  "cas",
);

const plan = deferred(
  "plan",
  "prx.plan.v1",
  "GH-1824",
  ["unitId", "scope", "implementationSteps", "verification"],
  "cas",
);

// prx-4fa (epic prx-997): filled — the pipeline's root artifact (intake's
// output / triage's input) is now typed. Concrete schema partially advances
// GH-1824's deferred-schema work for the `uow` slot specifically.
const uow = live(
  "uow",
  "prx.uow.v1",
  "schema:src/machine/contracts/lifecycle_artifacts.ts#uowSchema",
  ["id", "title", "status"],
  "git",
);

const patchProposal = deferred(
  "patch_proposal",
  "prx.patch_proposal.v1",
  "GH-1824",
  ["unitId", "diff", "rationale"],
  "cas",
);

const implementationNotes = deferred(
  "implementation_notes",
  "prx.implementation_notes.v1",
  "GH-1824",
  ["unitId", "notes"],
  "cas",
);

const patchCheck = deferred(
  "patch_check",
  "prx.patch_check.v1",
  "GH-1824",
  ["unitId", "ok", "findings"],
  "cas",
);

const guardCheck = deferred(
  "guard_check",
  "prx.guard_check.v1",
  "GH-1824",
  ["unitId", "ok", "guardId", "findings"],
  "cas",
);

const testRun = deferred(
  "test_run",
  "prx.test_run.v1",
  "GH-1824",
  ["unitId", "status", "ranSuites"],
  "cas",
);

const evidenceBundle = deferred(
  "evidence_bundle",
  "prx.evidence_bundle.v1",
  "GH-1824",
  ["unitId", "artifacts"],
  "cas",
);

const reviewBundle = deferred(
  "review_bundle",
  "prx.review_bundle.v1",
  "GH-1824",
  ["unitId", "verdict", "comments"],
  "cas",
);

// GH-1822: promoted to live — Zod schema in
// `src/machine/contracts/lifecycle_artifacts.ts` and JSON export in
// `schemas/contracts/lifecycle/blocker-report.json`.
const blockerReport = live(
  "blocker_report",
  "prx.blocker_report.v1",
  "schema:src/machine/contracts/lifecycle_artifacts.ts#blockerReportSchema",
  ["unitId", "owner", "unblock_condition", "severity", "reason"],
  "cas",
);

const questionBundle = deferred(
  "question_bundle",
  "prx.question_bundle.v1",
  "GH-1824",
  ["unitId", "questions"],
  "cas",
);

// Inputs that wrap operator-facing entry points (intake/triage/author/submit).
// These exist solely so every agent's 1→1 contract resolves to a registered
// type; the validation schemas are deferred to whichever ticket reifies the
// matching agent.

const externalSignal = deferred(
  "external_signal",
  "prx.external_signal.v1",
  "GH-1824",
  ["source", "payload"],
  "cas",
);

const uowQueue = deferred("uow_queue", "prx.uow_queue.v1", "GH-1824", ["units"], "cas");

const triagedQueue = deferred("triaged_queue", "prx.triaged_queue.v1", "GH-1824", ["units"], "cas");

const prSubmission = deferred(
  "pr_submission",
  "prx.pr_submission.v1",
  "GH-1824",
  ["unitId", "branch", "draft"],
  "cas",
);

const prBody = deferred("pr_body", "prx.pr_body.v1", "GH-1824", ["unitId", "title", "body"], "cas");

// GH-2326: gc (unified housekeeping) output artifact. `gc_report` is the
// reclaim/teardown result the gc role produces from a `uow` input. Registry
// stub so the gc role's 1→1 contract (uow → gc_report) resolves to a
// registered type; the Zod shape lives in src/machine/gc/schema.ts and is
// reified by GH-2327.
const gcReport = deferred(
  "gc_report",
  "prx.gc_report.v1",
  "GH-2326",
  ["status", "findings", "by_class"],
  "cas",
);

// GH-2394: scratch-session artifact. `scratch` is an ad-hoc, work-unit-
// UNBOUND least-privilege session with no artifact pipeline — its 1→1
// contract is a self-edge (scratch_session → scratch_session). Registry stub
// so the contract resolves to a registered type; there is no reifying ticket
// because scratch produces no durable artifact (it is an interactive session).
const scratchSession = deferred(
  "scratch_session",
  "prx.scratch_session.v1",
  "GH-2394",
  ["cwd", "unsafe"],
  "cas",
);

const query = deferred("query", "prx.query.v1", "GH-1824", ["kind", "args"], "cas");

const scoutResult = deferred(
  "scout_result",
  "prx.scout_result.v1",
  "GH-1824",
  ["query", "result"],
  "cas",
);

// ── GH-1822 lifecycle-axis artifacts ──────────────────────────────────────
//
// Three additional live artifacts (statusUpdate, delegationRecord,
// sprintPlan) join the live `blocker_report` entry above; together the four
// satisfy the GH-1822 issue body's success criteria. Eight further entries
// reserve named slots for follow-up shards (uow_candidate, work_map, …) so
// the Scrum-fit lifecycle has a complete vocabulary on day one.

const statusUpdate = live(
  "status_update",
  "prx.status_update.v1",
  "schema:src/machine/contracts/lifecycle_artifacts.ts#statusUpdateSchema",
  ["unitId", "uow_refs", "body", "author", "ts"],
  "cas",
);

const delegationRecord = live(
  "delegation_record",
  "prx.delegation_record.v1",
  "schema:src/machine/contracts/lifecycle_artifacts.ts#delegationRecordSchema",
  ["unitId", "assigned_to", "expected_output_type", "capabilities", "delegated_by"],
  "cas",
);

const sprintPlan = live(
  "sprint_plan",
  "prx.sprint_plan.v1",
  "schema:src/machine/contracts/lifecycle_artifacts.ts#sprintPlanSchema",
  ["sprint_uow_id", "selected_uow_ids", "start_date", "end_date"],
  "cas",
);

// Deferred placeholders for the rest of the lifecycle vocabulary. Each one
// is a named slot follow-up shards will fill; the validationRef cites this
// ticket so consumers can trace the registration back to the lifecycle
// spike.
const uowCandidate = deferred(
  "uow_candidate",
  "prx.uow_candidate.v1",
  "GH-1822",
  ["sourceRef", "title", "rationale"],
  "cas",
);

const workMap = deferred(
  "work_map",
  "prx.work_map.v1",
  "GH-1822",
  ["unitId", "nodes", "edges"],
  "cas",
);

const acceptanceRecord = deferred(
  "acceptance_record",
  "prx.acceptance_record.v1",
  "GH-1822",
  ["unitId", "criteria", "verdict"],
  "cas",
);

const followupUow = deferred(
  "followup_uow",
  "prx.followup_uow.v1",
  "GH-1822",
  ["parent_uow_id", "title", "rationale"],
  "cas",
);

const processChangeProposal = deferred(
  "process_change_proposal",
  "prx.process_change_proposal.v1",
  "GH-1822",
  ["proposer", "change", "rationale"],
  "cas",
);

const retroNote = deferred(
  "retro_note",
  "prx.retro_note.v1",
  "GH-1822",
  ["sprint_uow_id", "author", "body"],
  "cas",
);

const sprintDigest = deferred(
  "sprint_digest",
  "prx.sprint_digest.v1",
  "GH-1822",
  ["sprint_uow_id", "completed_uow_ids", "carryover_uow_ids"],
  "cas",
);

const stakeholderSummary = deferred(
  "stakeholder_summary",
  "prx.stakeholder_summary.v1",
  "GH-1822",
  ["audience", "headline", "body"],
  "cas",
);

// ── composite (curry-target) artifacts ────────────────────────────────────

const executorInputBundle = composite(
  "executor_input_bundle",
  "prx.executor_input_bundle.v1",
  ["context_bundle", "plan", "uow"],
  "GH-1824",
);

const testerInputBundle = composite(
  "tester_input_bundle",
  "prx.tester_input_bundle.v1",
  ["patch_proposal", "plan"],
  "GH-1824",
);

const reviewerInputBundle = composite(
  "reviewer_input_bundle",
  "prx.reviewer_input_bundle.v1",
  ["patch_proposal", "test_run", "plan"],
  "GH-1824",
);

// Residual artifacts the curry() helper resolves to (one component dropped).

const executorMinusContext = composite(
  "executor_minus_context",
  "prx.executor_minus_context.v1",
  ["plan", "uow"],
  "GH-1824",
);

const executorMinusPlan = composite(
  "executor_minus_plan",
  "prx.executor_minus_plan.v1",
  ["context_bundle", "uow"],
  "GH-1824",
);

const executorMinusUow = composite(
  "executor_minus_uow",
  "prx.executor_minus_uow.v1",
  ["context_bundle", "plan"],
  "GH-1824",
);

const testerMinusPlan = composite(
  "tester_minus_plan",
  "prx.tester_minus_plan.v1",
  ["patch_proposal"],
  "GH-1824",
);

const testerMinusPatch = composite(
  "tester_minus_patch",
  "prx.tester_minus_patch.v1",
  ["plan"],
  "GH-1824",
);

const reviewerMinusPatch = composite(
  "reviewer_minus_patch",
  "prx.reviewer_minus_patch.v1",
  ["test_run", "plan"],
  "GH-1824",
);

const reviewerMinusTestRun = composite(
  "reviewer_minus_test_run",
  "prx.reviewer_minus_test_run.v1",
  ["patch_proposal", "plan"],
  "GH-1824",
);

const reviewerMinusPlan = composite(
  "reviewer_minus_plan",
  "prx.reviewer_minus_plan.v1",
  ["patch_proposal", "test_run"],
  "GH-1824",
);

// ── registry ──────────────────────────────────────────────────────────────

const entries: ArtifactContract[] = [
  rawStateV1,
  dispatchRequest,
  dispatchResult,
  runtimeOutput,
  deriveTransition,
  contextBundle,
  plan,
  uow,
  patchProposal,
  implementationNotes,
  patchCheck,
  guardCheck,
  testRun,
  evidenceBundle,
  reviewBundle,
  blockerReport,
  questionBundle,
  externalSignal,
  uowQueue,
  triagedQueue,
  prSubmission,
  prBody,
  gcReport,
  scratchSession,
  query,
  scoutResult,
  statusUpdate,
  delegationRecord,
  sprintPlan,
  uowCandidate,
  workMap,
  acceptanceRecord,
  followupUow,
  processChangeProposal,
  retroNote,
  sprintDigest,
  stakeholderSummary,
  executorInputBundle,
  testerInputBundle,
  reviewerInputBundle,
  executorMinusContext,
  executorMinusPlan,
  executorMinusUow,
  testerMinusPlan,
  testerMinusPatch,
  reviewerMinusPatch,
  reviewerMinusTestRun,
  reviewerMinusPlan,
];

export const artifactRegistry: Readonly<Record<string, ArtifactContract>> = Object.freeze(
  Object.fromEntries(entries.map((entry) => [entry.type, entry])),
);

export function listArtifactContracts(): readonly ArtifactContract[] {
  return entries;
}

export function getArtifactContract(type: string): ArtifactContract | undefined {
  return artifactRegistry[type];
}

/**
 * Residual lookup used by `curry(...)`. Given a composite artifact and a
 * component to bind, returns the registered artifact whose `composedOf` is
 * the original list minus that component.
 */
export function residualArtifactType(composite: string, dropped: string): string {
  const entry = artifactRegistry[composite];
  if (!entry) {
    throw new Error(`unknown composite artifact: ${composite}`);
  }
  if (!entry.composedOf || !entry.composedOf.includes(dropped)) {
    throw new Error(
      `artifact ${composite} is not composed of ${dropped}; composedOf=${JSON.stringify(
        entry.composedOf ?? null,
      )}`,
    );
  }
  const remaining = entry.composedOf.filter((c) => c !== dropped).sort();
  for (const candidate of entries) {
    if (!candidate.composedOf) continue;
    const sorted = [...candidate.composedOf].sort();
    if (sorted.length === remaining.length && sorted.every((c, i) => c === remaining[i])) {
      return candidate.type;
    }
  }
  throw new Error(
    `no residual artifact registered for ${composite} minus ${dropped}; ` +
      `expected one whose composedOf == ${JSON.stringify(remaining)}`,
  );
}
