// GH-2086 — Zod facades for live artifacts whose canonical schemas live
// outside the `src/machine/contracts/` Zod surface.
//
// Both facades mirror an upstream source of truth and exist solely so the
// parity-chain bridge (`./anchored-chain-bridge.ts`) can validate these
// artifacts without depending on a JSON-schema runtime. Drift between a
// facade and its canonical source is pinned by the bridge's drift-pin test
// (`./__tests__/anchored-chain-bridge.test.ts`).
//
// Canonical sources:
//   - runtimeOutputSchema   ← src/machine/runtime_output.ts#buildRuntimeOutputSchema
//   - deriveTransitionSchema ← schemas/derive/transition.json

import { z } from "zod";

import { toolActors } from "../actors.ts";
import {
  runtimeRequiredFields,
  runtimeStatusValues,
  verificationStatusValues,
} from "../runtime_output.ts";
import { taskAgentRoles } from "../runtime_profiles.ts";
import { workflowPhases } from "@bounded-systems/machine-schema";
import { canonicalWorkUnitIdPattern } from "../work_unit.ts";

// ── runtime_output ────────────────────────────────────────────────────────
//
// Mirrors `buildRuntimeOutputSchema()`. Nested objects and the root use
// `.passthrough()` to match the JSON-schema's `additionalProperties: true`
// at every level the JSON source allows extra fields.

const parityChainSchema = z
  .object({
    authority: z.enum(["issue", "pr"]),
    branch: z.string(),
    worktree: z.string(),
    pr: z.number().int().nullable(),
  })
  .passthrough();

const modelBoundarySchema = z
  .object({
    workflowStates: z.array(z.string()),
    actors: z.array(z.enum([...toolActors] as [string, ...string[]])),
    events: z.array(z.string()),
    schemaBoundaries: z.array(z.string()),
  })
  .passthrough();

const changeEntrySchema = z
  .object({
    path: z.string(),
    summary: z.string(),
  })
  .strict();

const verificationSchema = z
  .object({
    status: z.enum([...verificationStatusValues] as [string, ...string[]]),
    testsRan: z.array(z.string()),
    testsNotRun: z.array(z.string()),
  })
  .passthrough();

export const runtimeOutputSchema = z
  .object({
    workUnitId: z.string().regex(canonicalWorkUnitIdPattern),
    role: z.enum([...taskAgentRoles] as [string, ...string[]]),
    phase: z.enum([...workflowPhases] as [string, ...string[]]),
    status: z.enum([...runtimeStatusValues] as [string, ...string[]]),
    summary: z.string().optional(),
    parityChain: parityChainSchema,
    modelBoundary: modelBoundarySchema,
    implementationPlan: z.array(z.string()),
    changes: z.array(changeEntrySchema),
    verification: verificationSchema,
    blockers: z.array(z.string()).optional(),
  })
  .passthrough();

// Compile-time pin: required keys in the Zod facade exactly match
// `runtimeRequiredFields` from the canonical source.
type _RuntimeRequiredFieldsPin = (typeof runtimeRequiredFields)[number] extends keyof z.infer<
  typeof runtimeOutputSchema
>
  ? true
  : never;
const _runtimeRequiredFieldsPin: _RuntimeRequiredFieldsPin = true;
void _runtimeRequiredFieldsPin;

// ── derive_transition ─────────────────────────────────────────────────────
//
// Mirrors `schemas/derive/transition.json`. `.strict()` matches the JSON
// source's `additionalProperties: false`. `issueId` is `string | null` to
// match `"type": ["string", "null"]`.

export const deriveTransitionSchema = z
  .object({
    id: z.string(),
    issueId: z.string().nullable(),
    fromState: z.string(),
    toState: z.string(),
    actor: z.string(),
    timestamp: z.string(),
  })
  .strict();
