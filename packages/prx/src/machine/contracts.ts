// GH-1821 — AgentContract / ArtifactContract / TransitionContract trinity.
//
// Invariant statement (from the spike):
//
//   Every PRX actor consumes typed artifacts and emits typed artifacts.
//   Actors do not own state. Actors do not have ambient authority. State is
//   derived from the artifact graph.
//
// Algebraic rule: every AgentContract is strictly 1-input-artifact → 1-output
// -artifact. Multi-input agents are expressed by *currying* — the composite
// input is itself a named product artifact in the registry, composed
// (`composedOf:`) from simpler artifacts. The agent then maps 1→1 over those
// composite types.
//
// Zod here is the source of truth (per the reference-zod-boundary-layer
// convention used by dispatch.ts / runtime_output.ts). JSON Schema artifacts
// are exported by scripts/export-contract-schemas.ts so downstream tooling
// (CLI, audit, future actors) can consume them without importing TS.

import { z } from "zod";

import { dispatchActors } from "./dispatch.ts";
import {
  sessionProfileNames,
  taskAgentRoles,
} from "./runtime_profiles.ts";

// ── identifiers ───────────────────────────────────────────────────────────

/** Snake-case identifier used to address artifact types. */
const artifactTypeIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9_]*$/, "artifact ids must be snake_case");

/** Pattern `prx.<type>.v<n>` — mirrors the runtime-output schema-version shape. */
const schemaVersionSchema = z
  .string()
  .regex(/^prx\.[a-z][a-z0-9_]*\.v\d+$/);

/**
 * `validationRef` points readers at the Zod / JSON-schema that validates an
 * instance of this artifact. Allowed shapes:
 *
 *   - `schema:<repo-relative-path>` — checked-in JSON-schema artifact.
 *   - `cas://sha256:<hex>` — CAS handle (already typed dispatch outputs).
 *   - `deferred:<follow-up-ticket>` — placeholder; the artifact is registered
 *     here so the trinity is complete, but the Zod-level schema lives in a
 *     follow-up shard.
 */
const validationRefSchema = z
  .string()
  .regex(/^(schema:.+|cas:\/\/sha256:[0-9a-f]{64}|deferred:GH-\d+)$/);

const persistenceSchema = z.enum(["git", "dolt", "cas"]);

// ── ArtifactContract ──────────────────────────────────────────────────────

export const artifactContractSchema = z
  .object({
    type: artifactTypeIdSchema,
    schemaVersion: schemaVersionSchema,
    requiredFields: z.array(z.string().min(1)).min(0),
    validationRef: validationRefSchema,
    persistence: persistenceSchema,
    /**
     * Populated for *composite* (curry-target) artifacts. An agent that takes
     * a `composedOf` artifact is the curried form of an N-arg agent whose
     * inputs are the listed component artifact types.
     */
    composedOf: z.array(artifactTypeIdSchema).optional(),
  })
  .strict();

export type ArtifactContract = z.infer<typeof artifactContractSchema>;

// ── AgentContract ─────────────────────────────────────────────────────────

const agentRoleSchema = z.enum([
  ...taskAgentRoles,
  ...sessionProfileNames,
] as [string, ...string[]]);

export const agentContractSchema = z
  .object({
    role: agentRoleSchema,
    /** Exactly one input artifact (use a composite `composedOf` type for N-arg agents). */
    inputArtifact: artifactTypeIdSchema,
    /** Exactly one output artifact. */
    outputArtifact: artifactTypeIdSchema,
    capabilities: z.array(z.string().min(1)),
    forbidden: z.array(z.string().min(1)),
  })
  .strict();

export type AgentContract = z.infer<typeof agentContractSchema>;

// ── TransitionContract ────────────────────────────────────────────────────
//
// The trinity must keep three phase axes distinct:
//
//   - role      — planner → executor → tester → reviewer → done|blocked
//   - workflow  — the 16-state RawStateV1 backbone (cleaned … in_review)
//   - lifecycle — GH-1822 Scrum-fit wrapper:
//                   intake → shape → map → delegate → execute → review
//                       → promote → monitor → report → retro
//
// `axis` is mandatory so guards never conflate them. `derivePhase` computes
// the workflow axis from RawStateV1; the role axis comes from agent
// emissions today; the lifecycle axis is documentary in this spike — it
// wraps the role and workflow axes without adding XState states (see
// `docs/spikes/GH-1822-uow-rooted-lifecycle.md`).

export const transitionAxes = ["role", "workflow", "lifecycle"] as const;
export type TransitionAxis = (typeof transitionAxes)[number];

// GH-1822: `aggregate_uow_id` references a UoW whose `kind` is one of these.
// Free-floating artifacts are rejected: every registered artifact either
// carries a `uow_id` pointing at a leaf UoW, or carries an
// `aggregate_uow_id` referencing an aggregate (epic / sprint / release /
// spike). The aggregate kinds live on this axis-level enum because they
// are referenced by every artifact slot in the registry, not just the
// lifecycle-axis transitions.
export const aggregateUowKinds = [
  "epic",
  "sprint",
  "release",
  "spike",
] as const;
export type AggregateUowKind = (typeof aggregateUowKinds)[number];
export const aggregateUowKindSchema = z.enum(aggregateUowKinds);

export const transitionContractSchema = z
  .object({
    axis: z.enum(transitionAxes),
    fromPhase: z.string().min(1),
    toPhase: z.string().min(1),
    /** Exactly one required artifact (bundle via composedOf for multi-artifact gates). */
    requiredArtifact: artifactTypeIdSchema,
    requiredStatus: z.enum(["passed", "present"]),
    forbiddenArtifacts: z.array(artifactTypeIdSchema),
    /** Pure-function id; implementation lives in src/machine/contracts/guards.ts. */
    guardId: z.string().min(1),
  })
  .strict();

export type TransitionContract = z.infer<typeof transitionContractSchema>;

// ── curry helper ──────────────────────────────────────────────────────────
//
// Curries a 1→1 contract whose `inputArtifact` is a composite (composedOf)
// type by binding one of the components. The result is a *new* 1→1 contract
// whose input is the residual composite. The residual lookup is provided by
// the caller (the artifact registry); this keeps the helper a pure function
// of its inputs.
//
// Example: executor: ExecutorInputBundle (ContextBundle × Plan × UoW) → PatchProposal.
//   curry(executor, "context_bundle", findResidual) =>
//     executor: ExecutorMinusContext (Plan × UoW) → PatchProposal.

export class CurryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CurryError";
  }
}

export function curry(
  agent: AgentContract,
  bindArtifactType: string,
  resolveResidual: (composite: string, dropped: string) => string,
): AgentContract {
  if (agent.inputArtifact === bindArtifactType) {
    throw new CurryError(
      `cannot curry the entire input: agent ${agent.role} already takes ${bindArtifactType} as its sole input`,
    );
  }
  const residual = resolveResidual(agent.inputArtifact, bindArtifactType);
  return agentContractSchema.parse({
    ...agent,
    inputArtifact: residual,
  });
}

// ── shared utility types ─────────────────────────────────────────────────

/**
 * The artifact-graph stub a guard inspects. Real graphs will carry typed
 * payloads keyed by artifact type; the trinity only requires the *shape* —
 * "does an instance of type T exist and what is its status".
 */
export const artifactGraphSchema = z.record(
  artifactTypeIdSchema,
  z
    .object({
      status: z.enum(["passed", "present", "failed", "absent"]).optional(),
    })
    .passthrough(),
);

export type ArtifactGraph = z.infer<typeof artifactGraphSchema>;

export type GuardVerdict =
  | { ok: true }
  | { ok: false; reason: string };

// ── re-exports for downstream consumers ───────────────────────────────────

export const dispatchActorRoles = dispatchActors;
