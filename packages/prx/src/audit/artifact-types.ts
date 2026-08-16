// GH-1823 — typed artifact-type registry for the audit verb.
//
// The audit verb measures whether the artifact graph that GH-1824's
// architecture promises is actually being produced. To do that, it needs a
// fixed vocabulary of artifact types so sibling shards
// (GH-1817 / GH-1818 / GH-1821 / GH-1822) can land their Zod/JSON schemas
// into pre-committed slots without renegotiating slot names.
//
// This module commits to:
//   1. The list of artifact-type names (`artifactTypeNames`).
//   2. The status semantics each slot can take (`artifactStatusValues`).
//   3. The shape of an `ArtifactSlot` row, which becomes a `uow_artifacts`
//      row in the metrics store.
//   4. Per-type metadata declaring whether the slot requires UoW attachment,
//      requires lineage (`input_refs`), and which workflow phases require
//      the slot to be present.
//
// No runtime behavior beyond schema validation lives here. The ingester
// (`src/audit/store/ingest.ts`) and the predicates (`src/audit/invariants.ts`)
// consume this vocabulary; the sibling shards land concrete payload schemas
// (`PatchProposal`, `TestRun`, `WorkMap`, etc.) later.

import { z } from "zod";

import { workflowPhases } from "@bounded-systems/machine-schema";

// Canonical artifact-type names. Order is the chain order the projector
// walks when computing `next_valid_action` (first absent required slot in
// `required_for_phases` order wins).
export const artifactTypeNames = [
  "work_map",
  "delegation_record",
  "context_bundle",
  "plan",
  "patch_proposal",
  "patch_check",
  "guard_check",
  "test_plan",
  "test_run",
  "review_bundle",
  "status_update",
  "blocker_report",
  "tree_projection",
  "runner_contract",
] as const;

export const artifactTypeSchema = z.enum(artifactTypeNames);
export type ArtifactType = z.infer<typeof artifactTypeSchema>;

// Slot status. `absent` is the default before any event lands the slot;
// `pending` is a sibling-issued "I'm working on it" signal; `present` means
// the artifact exists but has no pass/fail outcome yet; `passed` / `failed`
// are terminal outcomes; `blocked` is reserved for slots whose preconditions
// are not yet met (e.g. review_bundle while test_run is absent).
export const artifactStatusValues = [
  "absent",
  "pending",
  "present",
  "passed",
  "failed",
  "blocked",
  "invalid_evidence",
] as const;

export const artifactStatusSchema = z.enum(artifactStatusValues);
export type ArtifactStatus = z.infer<typeof artifactStatusSchema>;

export const artifactSlotSchema = z.object({
  type: artifactTypeSchema,
  status: artifactStatusSchema,
  ref: z.string().nullable(),
  uow_id: z.string(),
  input_refs: z.array(z.string()),
  last_seen_ts: z.string().nullable(),
});
export type ArtifactSlot = z.infer<typeof artifactSlotSchema>;

// Per-type metadata. `required_for_phases` is the set of derived workflow
// phases at/after which the slot is required for the UoW's adherence to
// count as `present` on the artifact-coverage metric.
export type ArtifactTypeMeta = {
  owning_uow_required: boolean;
  lineage_required: boolean;
  required_for_phases: readonly (typeof workflowPhases)[number][];
};

export const artifactTypeMeta: Readonly<Record<ArtifactType, ArtifactTypeMeta>> = {
  work_map: {
    owning_uow_required: true,
    lineage_required: false,
    required_for_phases: ["branch_created", "committing", "pushed"],
  },
  delegation_record: {
    owning_uow_required: true,
    lineage_required: true,
    required_for_phases: ["committing", "pushed"],
  },
  context_bundle: {
    owning_uow_required: true,
    lineage_required: false,
    required_for_phases: ["committing", "pushed"],
  },
  plan: {
    owning_uow_required: true,
    lineage_required: true,
    required_for_phases: ["committing", "pushed"],
  },
  patch_proposal: {
    owning_uow_required: true,
    lineage_required: true,
    required_for_phases: ["pushed", "draft", "ready_for_review", "in_review"],
  },
  patch_check: {
    owning_uow_required: true,
    lineage_required: true,
    required_for_phases: ["draft", "ready_for_review", "in_review"],
  },
  guard_check: {
    owning_uow_required: true,
    lineage_required: true,
    required_for_phases: ["draft", "ready_for_review", "in_review"],
  },
  test_plan: {
    owning_uow_required: true,
    lineage_required: false,
    required_for_phases: ["ready_for_review", "in_review"],
  },
  test_run: {
    owning_uow_required: true,
    lineage_required: true,
    required_for_phases: ["ready_for_review", "in_review", "ready_to_merge"],
  },
  review_bundle: {
    owning_uow_required: true,
    lineage_required: true,
    required_for_phases: ["in_review", "ready_to_merge"],
  },
  status_update: {
    owning_uow_required: true,
    lineage_required: false,
    required_for_phases: [],
  },
  blocker_report: {
    owning_uow_required: true,
    lineage_required: false,
    required_for_phases: [],
  },
  tree_projection: {
    owning_uow_required: false,
    lineage_required: false,
    required_for_phases: [],
  },
  runner_contract: {
    owning_uow_required: false,
    lineage_required: false,
    required_for_phases: [],
  },
};

// Convenience: the ordered chain shown by `prx audit uow <id>` for the
// "artifact chain" line. Ordering follows the workflow lifecycle.
export const artifactChainOrder: readonly ArtifactType[] = [
  "work_map",
  "delegation_record",
  "context_bundle",
  "plan",
  "patch_proposal",
  "patch_check",
  "guard_check",
  "test_plan",
  "test_run",
  "review_bundle",
] as const;

export function requiredArtifactTypesForPhase(
  phase: (typeof workflowPhases)[number],
): readonly ArtifactType[] {
  return artifactTypeNames.filter((type) =>
    artifactTypeMeta[type].required_for_phases.includes(phase),
  );
}
