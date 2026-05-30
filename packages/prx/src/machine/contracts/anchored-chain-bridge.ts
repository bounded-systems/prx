// GH-1962 — parity-chain ↔ AgentContract bridge.
//
// Architectural rule (parity-chain spike, lines 468–470): parity-chain
// depends on contracts, not vice versa. The adapter therefore lives on the
// machine side and exposes a `ContractRegistry` that the parity-chain
// validation layer can consume without importing machine internals.
//
// The bridge wraps exactly one `AgentContract` and only knows how to
// validate that agent's input/output artifact types. For every other
// artifact type, it returns `{ ok: true }` — out-of-scope verdicts compose
// under union, so multiple bridges can be combined without conflict.
//
// Live machine-side Zod schemas are passed in via `schemas`. Artifact types
// that the agent owns but have no schema entry are reported as deferred
// failures so the verdict surface distinguishes "unknown" from "wrong".

import type { z } from "zod";

import { sha256Hex } from "@bounded-systems/anchored-chain";
import type {
  ContractId,
  ContractRegistry,
  Digest,
  VerdictResult,
} from "@bounded-systems/anchored-chain";

import type { AgentContract } from "../contracts.ts";
import { dispatchRequestSchema, dispatchResultSchema } from "../dispatch.ts";
import { rawStateV1Schema } from "@bounded-systems/machine-schema";
import {
  deriveTransitionSchema,
  runtimeOutputSchema,
} from "./derived_artifact_schemas.ts";
import {
  blockerReportSchema,
  delegationRecordSchema,
  sprintPlanSchema,
  statusUpdateSchema,
} from "./lifecycle_artifacts.ts";

export interface AnchoredChainBridgeArgs {
  readonly agent: AgentContract;
  /** Static map: artifact-type id → Zod schema. */
  readonly schemas: Readonly<Record<string, z.ZodTypeAny>>;
  /**
   * Optional sync blob lookup. The bridge uses it only when the validator
   * is called without `bytes`. Async stores must be pre-cached by the
   * caller before invoking the validator.
   */
  readonly blobLookup?: (digest: Digest) => Uint8Array | undefined;
}

/** Wrap one AgentContract as a `ContractRegistry`. */
export function anchoredChainBridge(args: AnchoredChainBridgeArgs): ContractRegistry {
  const { agent, schemas, blobLookup } = args;
  const inScope = new Set<string>([agent.inputArtifact, agent.outputArtifact]);

  return {
    getValidator(
      artifactType: ContractId,
    ): (digest: Digest, bytes?: Uint8Array) => VerdictResult {
      const typeId = artifactType as unknown as string;

      if (!inScope.has(typeId)) {
        return () => ({ ok: true });
      }

      const schema = schemas[typeId];
      if (schema === undefined) {
        return () => ({
          ok: false,
          reason: `artifact ${typeId} deferred — no live Zod schema`,
        });
      }

      return (digest: Digest, bytes?: Uint8Array): VerdictResult => {
        const resolved = bytes ?? blobLookup?.(digest);
        if (resolved === undefined) {
          return {
            ok: false,
            reason: `bytes unavailable for digest ${digest}`,
          };
        }

        if (sha256Hex(resolved) !== digest) {
          return { ok: false, reason: "digest mismatch" };
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder().decode(resolved));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { ok: false, reason: `not valid JSON: ${message}` };
        }

        const result = schema.safeParse(parsed);
        if (result.success) {
          return { ok: true };
        }
        const issues = result.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ");
        return { ok: false, reason: issues };
      };
    },
  };
}

/**
 * Static map of the machine-side artifact types whose live Zod schemas have
 * shipped on `main`. Callers pass this directly into `anchoredChainBridge`
 * when wrapping an agent whose surface lives entirely in the live set.
 */
export function defaultMachineSchemaMap(): Readonly<Record<string, z.ZodTypeAny>> {
  return {
    raw_state_v1: rawStateV1Schema,
    dispatch_request: dispatchRequestSchema,
    dispatch_result: dispatchResultSchema,
    blocker_report: blockerReportSchema,
    status_update: statusUpdateSchema,
    delegation_record: delegationRecordSchema,
    sprint_plan: sprintPlanSchema,
    runtime_output: runtimeOutputSchema,
    derive_transition: deriveTransitionSchema,
  };
}
