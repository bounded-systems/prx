// ai-home-wlw5l — the exit-gate decision layer over the validate-then-pin core.
//
// This is the deterministic body a `command` Stop hook calls (per the Claude
// Code hooks reference): read the run's single transition-artifact slot, resolve
// the role's outputArtifact schema, validate-then-pin via `pinTransitionArtifact`,
// and map the result to a Stop decision — `allow` (the typed artifact is pinned
// to CAS, the run may finish) or `block` (the slot is empty/invalid, so
// termination is refused and the reason is fed back to the run).
//
// The thin stdin/exit-code wrapper script and the per-session settings wiring
// live in a follow-up slice; this layer holds the logic worth unit-testing.

import { z, type ZodType } from "zod";

import { PlanArtifactSchema } from "../plan-store/plan-artifact.ts";
import {
  pinTransitionArtifact,
  type PinTransitionDeps,
} from "./transition-artifact.ts";

// The floor: any JSON object. The gate ALWAYS enforces "a JSON object was
// emitted into the slot"; strict per-role `outputArtifact` schemas tighten it
// role-by-role as they land (only `plan` has one today — GH-2438 effect model).
const LOOSE_OBJECT_SCHEMA: ZodType = z.object({}).passthrough();

// Keyed on the canonical agent-role vocabulary (`taskAgentRoles`), which is
// what a session exports as `PRX_AGENT_ROLE` and what the Stop hook reads — e.g.
// the plan profile's role is `planner` (not `plan`), implement's is `executor`.
// `planner` produces the `plan` outputArtifact, so it maps to PlanArtifactSchema;
// other roles have no Zod schema yet and use the loose floor.
const ROLE_SCHEMAS: Readonly<Record<string, ZodType>> = {
  planner: PlanArtifactSchema,
};

/**
 * The Zod schema a role's transition artifact is validated against. `role` is
 * the `PRX_AGENT_ROLE` value (planner/executor/triage/intake/submit/author/…).
 * Falls back to the loose object floor for roles without a declared
 * `outputArtifact` schema yet, so the gate still rejects empty / non-JSON /
 * non-object slots.
 */
export function transitionSchemaForRole(role: string): ZodType {
  return ROLE_SCHEMAS[role] ?? LOOSE_OBJECT_SCHEMA;
}

export interface TransitionGateInput {
  /** Raw content of the run's transition-artifact slot. */
  raw: string;
  /** The `PRX_AGENT_ROLE` value (e.g. `planner`, `executor`, `triage`). */
  role: string;
  /** Work-unit id the run is bound to (for the CAS ref). */
  workUnitId: string;
  /** Injected CAS deps (for testing); defaults to the real plan-store. */
  deps?: PinTransitionDeps;
}

export type TransitionGateDecision =
  | { decision: "allow"; handle: string }
  | { decision: "block"; reason: string };

/**
 * Evaluate the exit gate. `allow` carries the pinned CAS handle; `block` carries
 * a reason the Stop hook feeds back to the run (which then keeps working until
 * it emits a valid artifact). Validate-then-pin: an invalid slot never pins.
 */
export async function evaluateTransitionGate(
  input: TransitionGateInput,
): Promise<TransitionGateDecision> {
  const schema = transitionSchemaForRole(input.role);
  const result = await pinTransitionArtifact(
    {
      raw: input.raw,
      schema,
      domain: input.role,
      ref: `transition:${input.role}:${input.workUnitId}`,
    },
    input.deps ?? {},
  );
  if (result.ok) {
    return { decision: "allow", handle: result.handle };
  }
  const reason =
    result.reason === "empty"
      ? `no transition artifact emitted — write the run's typed output to the ` +
        `slot before finishing (${input.role}/${input.workUnitId})`
      : `transition artifact rejected (${result.reason}): ${result.detail}`;
  return { decision: "block", reason };
}
